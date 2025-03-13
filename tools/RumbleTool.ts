// tools/RumbleTool.ts with focus on download and transcribe approach
import axios from 'axios';
import { Tool } from '@langchain/core/tools';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { TranscriptionService } from '../services/TranscriptionService';
import {
    TranscriptionProvider,
    TranscriptionOptions
} from '../commands/types';

const execAsync = promisify(exec);

export class RumbleTool extends Tool {
    name = "rumble_tool";
    description = "Retrieve content from Rumble videos by downloading and transcribing";
    tempDir: string;
    ytDlpAvailable: boolean = false;
    ffmpegAvailable: boolean = false;
    private transcriptionService: TranscriptionService;


    constructor(tempDir = './temp', config = {}) {
        super();
        this.tempDir = tempDir;
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }

        // Initialize transcription service
        // Initialize transcription service
        this.transcriptionService = new TranscriptionService({
            defaultProvider: 'local-cuda', // Use your RTX 3090 by default
            apiKeys: {
                'assemblyai': process.env.ASSEMBLYAI_API_KEY || '', // Add empty string as fallback
                'google': process.env.GOOGLE_API_KEY || ''          // Add empty string as fallback
            }
        });

        // Check dependencies availability
        this.checkDependenciesAvailability();
    }

    private async checkDependenciesAvailability(): Promise<void> {
        try {
            const ytDlpResult = await execAsync('yt-dlp --version');
            this.ytDlpAvailable = true;
            console.log(`yt-dlp version: ${ytDlpResult.stdout.trim()} is available`);
        } catch (error) {
            this.ytDlpAvailable = false;
            console.warn(`yt-dlp not available: ${error.message}`);
        }

        try {
            const ffmpegResult = await execAsync('ffmpeg -version');
            this.ffmpegAvailable = true;
            console.log(`ffmpeg is available`);
        } catch (error) {
            this.ffmpegAvailable = false;
            console.warn(`ffmpeg not available: ${error.message}`);
        }
    }

    static lc_name() {
        return "RumbleTool";
    }

    schema = z.object({
        input: z.string().optional().describe("A JSON string containing the Rumble URL and action"),
    }).transform(data => data.input ?? undefined);

    async _call(args: z.infer<typeof this.schema>): Promise<string> {
        try {
            if (!args) {
                return "Error: Missing input";
            }

            let { url, action } = JSON.parse(args);

            console.log(`Raw URL from input: "${url}"`);

            // Extract and validate the video ID
            const videoId = this.extractVideoId(url);
            console.log(`Extracted video ID: "${videoId}" from URL: "${url}"`);

            if (!videoId) {
                return "Error: Invalid Rumble URL. Please provide a valid Rumble video URL.";
            }

            // Normalize the URL for consistency
            const fullUrl = `https://rumble.com/embed/${videoId}`;

            switch (action) {
                case 'transcript': {
                    // Check if required tools are available
                    if (!this.ytDlpAvailable) {
                        return "Error: yt-dlp is required for transcript extraction but is not available. Please install it to use this feature.";
                    }

                    // Focus on downloading and transcribing
                    const transcript = await this.downloadAndTranscribe(videoId, fullUrl);
                    return transcript;
                }
                case 'metadata': {
                    const metadata = await this.getMetadata(videoId, fullUrl);
                    return metadata;
                }
                case 'download': {
                    // Check if yt-dlp is available
                    if (!this.ytDlpAvailable) {
                        return "Error: yt-dlp is required for video download but is not available. Please install it to use this feature.";
                    }

                    const downloadResult = await this.downloadVideo(videoId, fullUrl);
                    return downloadResult;
                }
                default:
                    return "Error: Unknown action. Available actions are: transcript, metadata, download";
            }
        } catch (error) {
            console.error("Rumble tool error:", error);
            return `Error: ${error instanceof Error ? error.message : 'Unknown error occurred while processing the Rumble request'}`;
        }
    }

    private extractVideoId(url: string): string | null {
        if (!url) {
            console.log('URL is empty or undefined');
            return null;
        }

        console.log(`Extracting video ID from: "${url}"`);

        // Standard Rumble URL pattern
        // Example: https://rumble.com/v4e1edj-video-title.html
        const videoPattern = /(?:https?:\/\/)?(?:www\.)?rumble\.com\/([a-zA-Z0-9]{6,})-[\w-]+\.html/i;
        const match = url.match(videoPattern);

        if (match && match[1]) {
            console.log(`Extracted ID via standard pattern: "${match[1]}"`);
            return match[1];
        }

        // Shortened URL pattern
        // Example: https://rumble.com/embed/v4e1edj
        const embedPattern = /(?:https?:\/\/)?(?:www\.)?rumble\.com\/embed\/([a-zA-Z0-9]{6,})/i;
        const embedMatch = url.match(embedPattern);

        if (embedMatch && embedMatch[1]) {
            console.log(`Extracted ID via embed pattern: "${embedMatch[1]}"`);
            return embedMatch[1];
        }

        // If it's already just an ID, return it
        if (/^[a-zA-Z0-9]{6,}$/.test(url)) {
            console.log(`URL is already a valid video ID: "${url}"`);
            return url;
        }

        console.log('Failed to extract video ID');
        return null;
    }

    private async downloadAndTranscribe(videoId: string, fullUrl: string): Promise<string> {
        try {
            console.log(`Downloading and transcribing video: ${videoId}`);

            // Generate unique output path based on videoId
            const outputDir = path.join(this.tempDir, videoId);
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            // First attempt to download just audio (faster and smaller)
            const audioPath = path.join(outputDir, `${videoId}.m4a`);
            console.log(`Downloading audio for ${videoId} to ${audioPath}`);

            try {
                // First check if the video exists and is accessible
                const videoCheckCmd = `yt-dlp --skip-download --dump-json ${fullUrl}`;
                const videoCheckResult = await execAsync(videoCheckCmd);

                // If we get here, the video exists, now download audio
                const downloadCmd = `yt-dlp -f "bestaudio[ext=m4a]" -o "${audioPath}" ${fullUrl}`;
                const downloadResult = await execAsync(downloadCmd);

                console.log(`Successfully downloaded audio: ${downloadResult.stdout}`);

                // Generate transcript from existing captions
                const captionsTranscript = await this.extractExistingCaptions(videoId, fullUrl, outputDir);
                if (captionsTranscript && captionsTranscript.length > 0) {
                    // Clean up files
                    this.cleanupTempFiles(outputDir);
                    return captionsTranscript;
                }

                // If we have ffmpeg, we can process the audio
                if (this.ffmpegAvailable) {
                    // Use OpenAI's Whisper API or a local whisper model
                    // Note: This is a placeholder - you'll need to implement actual transcription
                    const transcriptionResult = await this.transcribeAudio(audioPath);

                    // Clean up files
                    this.cleanupTempFiles(outputDir);

                    return transcriptionResult;
                } else {
                    return `Audio downloaded successfully to ${audioPath}. Please use a transcription service to generate a transcript.`;
                }

            } catch (downloadError) {
                console.error(`Error downloading video: ${downloadError}`);

                // Check if the error indicates the video doesn't exist
                if (downloadError.stderr && downloadError.stderr.includes('HTTP Error 410')) {
                    return "Video not found. This Rumble video appears to be unavailable or has been removed.";
                }

                // Try an alternative download method
                try {
                    const altDownloadCmd = `yt-dlp -f "best[filesize<50M]" -o "${outputDir}/${videoId}.mp4" ${fullUrl}`;
                    await execAsync(altDownloadCmd);

                    return `Video downloaded to ${outputDir}/${videoId}.mp4. Please use a transcription service to generate a transcript.`;

                } catch (altError) {
                    console.error(`Alternative download method failed: ${altError}`);
                    return `Failed to download video. Error: ${altError.message}`;
                }
            }

        } catch (error) {
            console.error(`Error in downloadAndTranscribe:`, error);

            if (error.message && error.message.includes('410')) {
                return "Video not found. This Rumble video appears to be unavailable or has been removed.";
            }

            return `Error downloading and transcribing: ${error.message}`;
        }
    }

    private async extractExistingCaptions(videoId: string, fullUrl: string, outputDir: string): Promise<string> {
        try {
            console.log(`Attempting to extract existing captions for ${videoId}`);

            // Try to download only captions
            const captionCmd = `yt-dlp --write-subs --skip-download --sub-langs all -o "${outputDir}/${videoId}" ${fullUrl}`;
            await execAsync(captionCmd);

            // Check if any subtitle files were downloaded
            const files = fs.readdirSync(outputDir);
            const subtitleFiles = files.filter(file =>
                file.endsWith('.vtt') ||
                file.endsWith('.srt') ||
                file.endsWith('.sbv')
            );

            if (subtitleFiles.length > 0) {
                // Found subtitle files - read and parse
                console.log(`Found ${subtitleFiles.length} subtitle files:`, subtitleFiles);

                // Read the first subtitle file (prefer .vtt if available)
                const vttFile = subtitleFiles.find(file => file.endsWith('.vtt'));
                const subtitleFile = vttFile || subtitleFiles[0];
                const subtitlePath = path.join(outputDir, subtitleFile);

                const subtitleContent = fs.readFileSync(subtitlePath, 'utf8');
                const parsedContent = this.parseSubtitleFile(subtitleContent, subtitleFile);

                console.log(`Successfully extracted transcript from ${subtitleFile}`);
                return parsedContent;
            }

            console.log(`No subtitle files found for ${videoId}`);
            return '';

        } catch (error) {
            console.error(`Error extracting captions: ${error}`);
            return '';
        }
    }


    private parseSubtitleFile(content: string, filename: string): string {
        const ext = path.extname(filename).toLowerCase();

        switch (ext) {
            case '.vtt':
                return this.parseVTT(content);
            case '.srt':
                return this.parseSRT(content);
            default:
                // For other formats, attempt a generic parsing
                return this.parseGenericSubtitles(content);
        }
    }

    private parseVTT(content: string): string {
        // Remove WEBVTT header and styling
        let lines = content.split('\n');
        let result = '';
        let isTimestamp = false;

        // Skip WEBVTT header
        let startIndex = lines.findIndex(line => line.trim() === 'WEBVTT');
        if (startIndex !== -1) {
            lines = lines.slice(startIndex + 1);
        }

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip empty lines and numeric identifiers
            if (trimmed === '' || /^\d+$/.test(trimmed)) {
                continue;
            }

            // Skip timestamp lines
            if (trimmed.includes('-->')) {
                isTimestamp = true;
                continue;
            }

            // Skip style blocks
            if (trimmed.startsWith('STYLE') || trimmed.startsWith('NOTE')) {
                continue;
            }

            // If not a timestamp and not empty, it's actual content
            if (trimmed !== '') {
                if (isTimestamp) {
                    result += trimmed + ' ';
                    isTimestamp = false;
                } else {
                    // If it's a continuation of previous line, don't add extra spaces
                    result += trimmed + ' ';
                }
            }
        }

        return result.trim();
    }

    private parseSRT(content: string): string {
        let lines = content.split('\n');
        let result = '';
        let isTimestamp = false;

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip empty lines and numeric identifiers
            if (trimmed === '' || /^\d+$/.test(trimmed)) {
                continue;
            }

            // Skip timestamp lines
            if (trimmed.includes('-->')) {
                isTimestamp = true;
                continue;
            }

            // If not a timestamp and not empty, it's actual content
            if (trimmed !== '') {
                if (isTimestamp) {
                    result += trimmed + ' ';
                    isTimestamp = false;
                } else {
                    result += trimmed + ' ';
                }
            }
        }

        return result.trim();
    }

    private parseGenericSubtitles(content: string): string {
        // A more generic approach for unknown formats
        // Strip out anything that looks like timestamps or IDs
        let lines = content.split('\n');
        let result = '';

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip empty lines
            if (trimmed === '') continue;

            // Skip lines that look like timestamps (00:00:00,000 --> 00:00:00,000)
            if (trimmed.match(/\d+:\d+:\d+[.,]\d+ *--> *\d+:\d+:\d+[.,]\d+/)) continue;

            // Skip lines that are just numbers (likely IDs)
            if (/^\d+$/.test(trimmed)) continue;

            // Add content lines
            result += trimmed + ' ';
        }

        return result.trim();
    }

    private async getMetadata(videoId: string, fullUrl: string): Promise<string> {
        try {
            console.log(`Getting metadata for Rumble video: ${videoId}`);

            // Check if yt-dlp is available
            if (this.ytDlpAvailable) {
                // Generate unique output path
                const outputDir = path.join(this.tempDir, videoId);
                if (!fs.existsSync(outputDir)) {
                    fs.mkdirSync(outputDir, { recursive: true });
                }

                // Use yt-dlp to extract metadata
                const metadataCmd = `yt-dlp --skip-download --dump-json ${fullUrl}`;
                const metadataResult = await execAsync(metadataCmd);

                try {
                    const metadata = JSON.parse(metadataResult.stdout);

                    // Format metadata in a more readable way
                    const formattedMetadata = {
                        id: metadata.id || videoId,
                        title: metadata.title || 'Unknown Title',
                        description: metadata.description || '',
                        uploader: metadata.uploader || metadata.channel || 'Unknown Uploader',
                        uploadDate: metadata.upload_date || 'Unknown',
                        duration: metadata.duration || 0,
                        viewCount: metadata.view_count || 0,
                        likeCount: metadata.like_count || 0,
                        thumbnailUrl: metadata.thumbnail || '',
                        url: fullUrl
                    };

                    // Clean up temporary directory
                    this.cleanupTempFiles(outputDir);

                    return JSON.stringify(formattedMetadata, null, 2);
                } catch (parseError) {
                    console.error(`Error parsing metadata: ${parseError}`);
                    // Continue to fallback method
                }
            }

            // Fallback: Try to extract basic metadata from HTML
            console.log(`Attempting to extract metadata from webpage for ${videoId}`);

            try {
                const response = await axios.get(fullUrl);
                const html = response.data;

                // Extract title
                const titleMatch = html.match(/<title>(.*?)<\/title>/);
                const title = titleMatch ? titleMatch[1].replace(' - Rumble', '') : 'Unknown Title';

                // Extract other metadata
                const descriptionMatch = html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"[^>]*>/);
                const description = descriptionMatch ? descriptionMatch[1] : '';

                const ogImageMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"[^>]*>/);
                const thumbnailUrl = ogImageMatch ? ogImageMatch[1] : '';

                // Basic metadata object
                const basicMetadata = {
                    id: videoId,
                    title,
                    description,
                    thumbnailUrl,
                    url: fullUrl,
                    note: 'Limited metadata available without yt-dlp'
                };

                return JSON.stringify(basicMetadata, null, 2);

            } catch (htmlError) {
                console.error(`Error extracting HTML metadata: ${htmlError}`);

                // Return minimal metadata if everything fails
                return JSON.stringify({
                    id: videoId,
                    title: 'Unknown Title',
                    url: fullUrl,
                    note: 'Failed to retrieve detailed metadata'
                }, null, 2);
            }

        } catch (error) {
            console.error(`Error in getMetadata: ${error}`);

            if (error.message && error.message.includes('410')) {
                return JSON.stringify({
                    id: videoId,
                    error: "Video not found. This Rumble video appears to be unavailable or has been removed."
                }, null, 2);
            }

            return JSON.stringify({
                id: videoId,
                error: `Failed to retrieve metadata: ${error.message}`
            }, null, 2);
        }
    }

    private async downloadVideo(videoId: string, fullUrl: string): Promise<string> {
        try {
            console.log(`Downloading video: ${videoId}`);

            // Generate unique output path based on videoId
            const outputDir = path.join(this.tempDir, videoId);
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            const outputPath = path.join(outputDir, `${videoId}.mp4`);
            console.log(`Downloading to: ${outputPath}`);

            const downloadCmd = `yt-dlp -f "best[filesize<100M]" -o "${outputPath}" ${fullUrl}`;
            const downloadResult = await execAsync(downloadCmd);

            console.log(`Download completed: ${downloadResult.stdout}`);

            // Return the local path to the downloaded video
            return `Video downloaded successfully to: ${outputPath}`;

        } catch (error) {
            console.error(`Error in downloadVideo: ${error}`);

            if (error.message && error.message.includes('410')) {
                return "Video not found. This Rumble video appears to be unavailable or has been removed.";
            }

            return `Failed to download video: ${error.message}`;
        }
    }

    private cleanupTempFiles(directory: string): void {
        try {
            if (fs.existsSync(directory)) {
                const files = fs.readdirSync(directory);
                for (const file of files) {
                    fs.unlinkSync(path.join(directory, file));
                }
                fs.rmdirSync(directory);
            }
        } catch (error) {
            console.error('Error cleaning up temporary files:', error);
        }
    }




    private async transcribeAudio(audioPath: string, options: TranscriptionOptions = {}): Promise<string> {
        // Default options if not specified - define OUTSIDE the try block
        const transcriptionOptions = {
            provider: options.provider || 'local-cuda', // Use RTX 3090 by default
            modelSize: options.modelSize || 'medium',   // Good balance of accuracy and speed
            language: options.language || 'auto'        // Auto-detect language
        };

        try {
            console.log(`Transcribing audio file: ${audioPath}`);

            // Transcribe using the service
            const result = await this.transcriptionService.transcribe(audioPath, transcriptionOptions);

            // Return the transcribed text
            return result || 'Transcription produced no text.';
        } catch (error) {
            console.error('Error transcribing audio:', error);

            // If local transcription fails, try API as fallback
            if (transcriptionOptions.provider === 'local-cuda' || transcriptionOptions.provider === 'local-cpu') {
                try {
                    console.log('Local transcription failed, trying AssemblyAI as fallback...');
                    return await this.transcriptionService.transcribe(audioPath, {
                        ...transcriptionOptions,
                        provider: 'assemblyai'
                    });
                } catch (fallbackError) {
                    console.error('Fallback transcription also failed:', fallbackError);
                }
            }

            return `Error transcribing audio: ${error instanceof Error ? error.message : String(error)}. Please try again later.`;
        }
    }
}
