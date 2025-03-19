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
    TranscriptionOptions,
    TranscriptionEstimate
} from '../commands/types';
import { AssemblyAI } from 'assemblyai'

type StatusCallback = (status: string) => Promise<void>;

const execAsync = promisify(exec);

export class RumbleTool extends Tool {
    name = "rumble_tool";
    description = "Retrieve content from Rumble videos by downloading and transcribing";
    tempDir: string;
    ytDlpAvailable: boolean = false;
    ffmpegAvailable: boolean = false;
    private transcriptionService: TranscriptionService;

    transcriptionPreferences: Record<string, any> = {};
    assemblyAIAvailable: boolean = false;

    private statusCallback: StatusCallback | null = null;


    constructor(tempDir = './temp', config: {
        transcriptionPreferences?: Record<string, any>
    } = {}) {
        super();
        this.tempDir = tempDir;
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }


        // Initialize transcription service

        this.transcriptionService = new TranscriptionService({
            defaultProvider: 'local-cuda', // Use your RTX 3090 by default
            apiKeys: {
                'assemblyai': process.env.ASSEMBLYAI_API_KEY || '', // Add empty string as fallback
                'google': process.env.GOOGLE_API_KEY || ''          // Add empty string as fallback
            }
        });
        // Store transcription preferences from config
        this.transcriptionPreferences = config.transcriptionPreferences || {};

        // Check dependencies availability
        this.checkDependenciesAvailability();

        // Check if AssemblyAI is available
        this.assemblyAIAvailable = !!process.env.ASSEMBLYAI_API_KEY;
        if (this.assemblyAIAvailable) {
            console.log('AssemblyAI API key found, transcription service available');
        } else {
            console.log('AssemblyAI API key not found, some transcription features may be limited');
        }
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
    
            let { url, action, transcriptionOptions = {} } = JSON.parse(args);
    
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
    
                    // Focus on downloading and transcribing, now passing the transcription options
                    const transcript = await this.downloadAndTranscribe(videoId, fullUrl, transcriptionOptions);
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
        
        // Array of patterns to try in order
        const patterns = [
            // Standard URL format with v-prefix: rumble.com/v123abc-title.html
            /(?:https?:\/\/)?(?:www\.)?rumble\.com\/v([a-zA-Z0-9]{5,})-[\w\.-]+\.html/i,
            
            // Standard URL with full ID: rumble.com/v123abc-title.html (capturing the v-prefix too)
            /(?:https?:\/\/)?(?:www\.)?rumble\.com\/(v[a-zA-Z0-9]{5,})-[\w\.-]+\.html/i,
            
            // Embed format: rumble.com/embed/v123abc
            /(?:https?:\/\/)?(?:www\.)?rumble\.com\/embed\/([a-zA-Z0-9]{5,})/i,
            
            // Embed format with v-prefix: rumble.com/embed/v123abc
            /(?:https?:\/\/)?(?:www\.)?rumble\.com\/embed\/(v[a-zA-Z0-9]{5,})/i,
            
            // Short URL format (if any)
            /(?:https?:\/\/)?(?:www\.)?rumble\.com\/([a-zA-Z0-9]{6,})\/?$/i
        ];
        
        // Try each pattern
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match && match[1]) {
                // Normalize ID format - ensure it has the 'v' prefix
                const extractedId = match[1];
                const normalizedId = extractedId.startsWith('v') ? extractedId : `v${extractedId}`;
                console.log(`Extracted ID: "${extractedId}", Normalized: "${normalizedId}"`);
                return normalizedId;
            }
        }
        
        // If we get here, no standard patterns matched. Try one more general approach
        // Look for any segment that starts with v followed by at least 5 alphanumeric chars
        const generalMatch = url.match(/v([a-zA-Z0-9]{5,})/i);
        if (generalMatch) {
            const extractedPart = generalMatch[0]; // This includes the v prefix
            console.log(`Extracted ID via general pattern: "${extractedPart}"`);
            return extractedPart;
        }
        
        // If it's already just an ID format, return it (with v prefix if needed)
        if (/^v?[a-zA-Z0-9]{5,}$/.test(url)) {
            const normalizedId = url.startsWith('v') ? url : `v${url}`;
            console.log(`URL is already a valid video ID: "${url}", Normalized: "${normalizedId}"`);
            return normalizedId;
        }
        
        console.log('Failed to extract video ID');
        return null;
    }

private async downloadAndTranscribe(videoId: string, fullUrl: string, options: TranscriptionOptions = {}): Promise<string> {
        try {
            console.log(`Downloading and transcribing video: ${videoId}`);

            // Generate unique output path based on videoId
            const outputDir = path.join(this.tempDir, videoId);
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            // Create multiple URL variations to try
            const urlVariations = [
                `https://rumble.com/v${videoId}`,      // Direct URL with 'v' prefix (most likely to work)
                `https://rumble.com/${videoId}`,       // Direct URL without 'v' prefix
                fullUrl                               // Original URL (likely embed URL)
            ];

            let redirectedIds = new Set<string>();

            // First attempt to check available formats to guide our approach
            let availableFormats = '';
            let bestFormatId = '';
            let workingUrl = '';

            try {
                for (const url of urlVariations) {
                    try {
                        console.log(`Checking available formats for: ${url}`);
                        const { stdout, stderr } = await execAsync(`yt-dlp --list-formats ${url}`);
                        availableFormats = stdout;

                        // Check if we got redirected to a different video ID
                        const redirectMatch = stderr.match(/\[RumbleEmbed\] ([\w\d]+): Downloading/);
                        if (redirectMatch && redirectMatch[1] && redirectMatch[1] !== videoId) {
                            const redirectedId = redirectMatch[1];
                            console.log(`Detected redirect to video ID: ${redirectedId}`);
                            redirectedIds.add(redirectedId);

                            // Add the redirected URLs to our variations
                            urlVariations.push(`https://rumble.com/v${redirectedId}`);
                            urlVariations.push(`https://rumble.com/embed/${redirectedId}`);
                        }

                        console.log(`Successfully found formats for: ${url}`);
                        workingUrl = url; // Remember which URL worked
                        break; // Exit the loop if we successfully get formats
                    } catch (error) {
                        console.log(`Failed to get formats for ${url}: ${error.message}`);

                        // Check the error message for redirected video IDs
                        const redirectMatch = error.message.match(/\[RumbleEmbed\] ([\w\d]+):/);
                        if (redirectMatch && redirectMatch[1] && redirectMatch[1] !== videoId) {
                            const redirectedId = redirectMatch[1];
                            console.log(`Detected redirect to video ID: ${redirectedId} in error message`);
                            redirectedIds.add(redirectedId);

                            // Add the redirected URLs to our variations if not already present
                            const redirectUrl1 = `https://rumble.com/v${redirectedId}`;
                            const redirectUrl2 = `https://rumble.com/embed/${redirectedId}`;

                            if (!urlVariations.includes(redirectUrl1)) {
                                urlVariations.push(redirectUrl1);
                            }
                            if (!urlVariations.includes(redirectUrl2)) {
                                urlVariations.push(redirectUrl2);
                            }
                        }
                    }
                }
            } catch (error) {
                console.log(`Error checking formats: ${error.message}`);
            }

            // If we couldn't get format info from any URL, return early
            if (!availableFormats || !workingUrl) {
                return `Could not access this Rumble video. It may be private, removed, or region-restricted.`;
            }

            console.log('Available formats:');
            console.log(availableFormats);

            // Parse the available formats and find a suitable format ID
            const formatLines = availableFormats.split('\n');

            // First try to find an audio-only format
            const audioFormats = formatLines.filter(line => line.includes('audio only'));

            if (audioFormats.length > 0) {
                // Found audio-only format
                const formatMatch = audioFormats[0].match(/^(\S+)/);
                if (formatMatch && formatMatch[1]) {
                    bestFormatId = formatMatch[1];
                    console.log(`Found audio-only format ID: ${bestFormatId}`);
                }
            } else {
                // No audio-only format, look for a video format (smallest file size first)
                // Filter lines that look like actual formats (have mp4, have filesize)
                const videoFormats = formatLines.filter(line =>
                    line.includes('mp4') &&
                    !line.includes('video only') &&
                    line.match(/\d+\.\d+\w+/) // Has a file size
                );

                if (videoFormats.length > 0) {
                    // Find the format ID from the first video format
                    const formatMatch = videoFormats[0].match(/^(\S+)/);
                    if (formatMatch && formatMatch[1]) {
                        bestFormatId = formatMatch[1];
                        console.log(`Found video format ID: ${bestFormatId}`);
                    }
                }
            }

            // If we still don't have a format ID, try to extract it from raw format string
            if (!bestFormatId) {
                // Look for lines with "ID" and "EXT" to find the format ID column
                const headerLine = formatLines.find(line => line.includes('ID') && line.includes('EXT'));
                if (headerLine) {
                    // The next non-empty line should have a format
                    for (let i = formatLines.indexOf(headerLine) + 1; i < formatLines.length; i++) {
                        if (formatLines[i].trim() && !formatLines[i].startsWith('-')) {
                            const firstField = formatLines[i].trim().split(/\s+/)[0];
                            if (firstField) {
                                bestFormatId = firstField;
                                console.log(`Extracted format ID from table: ${bestFormatId}`);
                                break;
                            }
                        }
                    }
                }
            }

            // If we have a format ID, try to download with it
            if (bestFormatId) {
                console.log(`Using format ID: ${bestFormatId} with URL: ${workingUrl}`);
                const outputPath = path.join(outputDir, `${videoId}.download`);

                try {
                    // Use the specific format ID with the URL that worked
                    const downloadCmd = `yt-dlp -f ${bestFormatId} -o "${outputPath}" ${workingUrl}`;
                    console.log(`Running command: ${downloadCmd}`);
                    await execAsync(downloadCmd);

                    // Check if download succeeded
                    if (fs.existsSync(outputPath)) {
                        console.log(`Successfully downloaded with format ID: ${bestFormatId}`);

                        // Check for captions first
                        try {
                            const captionsTranscript = await this.extractExistingCaptions(videoId, workingUrl, outputDir);
                            if (captionsTranscript && captionsTranscript.length > 0) {
                                console.log(`Found captions for ${workingUrl}`);
                                this.cleanupTempFiles(outputDir);
                                return captionsTranscript;
                            }
                        } catch (error) {
                            console.log(`No captions found for ${workingUrl}: ${error.message}`);
                        }

                        // If no captions, extract audio and transcribe
                        if (this.ffmpegAvailable) {
                            const wavPath = path.join(outputDir, `${videoId}.wav`);
                            try {
                                console.log(`Extracting audio to WAV format at ${wavPath}`);
                                await execAsync(`ffmpeg -i "${outputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}"`);

                                if (fs.existsSync(wavPath)) {
                                    // Transcribe the audio
                                    const transcriptionResult = await this.transcribeAudio(wavPath, options, videoId);                                    this.cleanupTempFiles(outputDir);
                                    return transcriptionResult;
                                }
                            } catch (error) {
                                console.error(`Error extracting audio: ${error.message}`);
                            }
                        }

                        // If we couldn't extract audio or transcribe, return a message
                        return `Successfully downloaded the Rumble video, but could not extract audio for transcription.`;
                    } else {
                        console.log(`File not found after download: ${outputPath}`);
                    }
                } catch (error) {
                    console.log(`Failed to download with format ID ${bestFormatId}: ${error.message}`);
                }
            }

            // Fall back to trying common format IDs that often work with Rumble
            const commonFormatIds = ['mp4-360p-0', 'mp4-180p'];

            for (const formatId of commonFormatIds) {
                const outputPath = path.join(outputDir, `${videoId}.download`);

                try {
                    console.log(`Trying common format ID: ${formatId} with URL: ${workingUrl}`);
                    const downloadCmd = `yt-dlp -f ${formatId} -o "${outputPath}" ${workingUrl}`;
                    await execAsync(downloadCmd);

                    if (fs.existsSync(outputPath)) {
                        console.log(`Successfully downloaded with common format ID: ${formatId}`);

                        // Extract audio and transcribe
                        if (this.ffmpegAvailable) {
                            const wavPath = path.join(outputDir, `${videoId}.wav`);
                            try {
                                await execAsync(`ffmpeg -i "${outputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}"`);

                                if (fs.existsSync(wavPath)) {
                                    // Transcribe the audio
                                    const transcriptionResult = await this.transcribeAudio(wavPath, options, videoId);                                    this.cleanupTempFiles(outputDir);
                                    return transcriptionResult;
                                }
                            } catch (error) {
                                console.error(`Error extracting audio: ${error.message}`);
                            }
                        }

                        return `Successfully downloaded the Rumble video, but could not extract audio for transcription.`;
                    }
                } catch (error) {
                    console.log(`Failed to download with common format ID ${formatId}: ${error.message}`);
                }
            }

            // If everything else failed
            return `Could not download this Rumble video. Format not available or video is restricted.`;
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

    private cleanupTempFiles(directory: string, removeDir: boolean = true, keepFiles: string[] = []): void {
        try {
            if (fs.existsSync(directory)) {
                const files = fs.readdirSync(directory);
                for (const file of files) {
                    const filePath = path.join(directory, file);
                    // Skip files that should be kept
                    if (keepFiles.includes(filePath)) {
                        continue;
                    }
                    fs.unlinkSync(filePath);
                }
                if (removeDir) {
                    fs.rmdirSync(directory);
                }
            }
        } catch (error) {
            console.error('Error cleaning up temporary files:', error);
        }
    }




    private async transcribeAudio(audioPath: string, options: TranscriptionOptions = {}, videoId?: string): Promise<string> {
        try {
            console.log(`Transcribing audio file: ${audioPath}`);
    
            // Get file size for time estimation
            const fileStats = fs.statSync(audioPath);
            const fileSizeBytes = fileStats.size;
            console.log(`Audio file size for transcription: ${fileSizeBytes} bytes (${(fileSizeBytes / (1024 * 1024)).toFixed(2)} MB)`);
            
            // Determine which transcription method to use based on options or preferences
            const provider = options.provider || 'local-cuda'; // Default to local CUDA if available
            
            // Estimate transcription time
            const estimatedMinutes = this.estimateTranscriptionTime(fileSizeBytes, provider);
            console.log(`Estimated transcription time: ${estimatedMinutes} minutes`);
            
            // Log in a special format for the CommandHandler to parse
            if (videoId) {
                console.log(`TRANSCRIPTION_ESTIMATE:${videoId}:${estimatedMinutes}`);
            }
            
            this.publishTranscriptionEstimate(videoId as string, fileSizeBytes, provider);
            // Send status update if callback is available
            if (this.statusCallback) {
                const readableProvider = provider === 'local-cuda' ? 'GPU (CUDA)' : 
                                        provider === 'local-cpu' ? 'CPU' : 
                                        provider.charAt(0).toUpperCase() + provider.slice(1);
                
                await this.statusCallback(`Transcribing ${(fileSizeBytes / (1024 * 1024)).toFixed(1)}MB audio using ${readableProvider}. Estimated time: ${estimatedMinutes} minutes.`);
            }
    
            // Use AssemblyAI if selected
            if (provider === 'assemblyai') {
                console.log('Using AssemblyAI for transcription');
            
                // Get API key from options or environment variable
                const apiKey = options.apiKey || process.env.ASSEMBLYAI_API_KEY;
                if (!apiKey) {
                    throw new Error('AssemblyAI API key not provided');
                }
            
                // Import the AssemblyAI SDK
                const { AssemblyAI } = require('assemblyai');
                const client = new AssemblyAI({
                    apiKey: apiKey
                });
            
                // For local files, we need to upload first
                // Fix the language code - AssemblyAI doesn't support 'auto'
                let languageCode = options.language || 'en';
                // If language is set to 'auto', default to 'en' for AssemblyAI
                if (languageCode === 'auto') {
                    console.log('AssemblyAI does not support automatic language detection. Using English (en) as default.');
                    languageCode = 'en';
                }
            
                // Set params with the corrected language code
                const params = {
                    audio: audioPath,
                    speaker_labels: true,
                    language_code: languageCode
                };
                
                // Perform the transcription
                const transcript = await client.transcripts.transcribe(params);
    
                // Check for errors
                if (transcript.status === 'error') {
                    throw new Error(`AssemblyAI transcription failed: ${transcript.error}`);
                }
    
                // Return the transcript text
                return transcript.text || 'Transcription produced no text.';
            }
    
            // Use local Whisper if selected
            else if (provider === 'local-cuda' || provider === 'local-cpu') {
                console.log(`Using local Whisper (${provider}) for transcription`);
    
                // Check if whisper.cpp is available
                const whisperPath = '/usr/local/bin/whisper'; // Adjust as needed
                const modelSize = options.modelSize || 'medium';
                const modelPath = path.join(process.cwd(), 'models', `ggml-${modelSize}.bin`);
    
                // Check if model exists, download if necessary
                if (!fs.existsSync(modelPath)) {
                    console.log(`Model file not found: ${modelPath}, downloading...`);
                    // You would implement downloadModel here
                    // await this.downloadModel(modelSize);
                }
    
                if (fs.existsSync(whisperPath)) {
                    // Set device flag based on provider
                    const deviceFlag = provider === 'local-cuda' ? '--device cuda' : '';
                    // Set language flag if specified
                    const langFlag = options.language && options.language !== 'auto'
                        ? `--language ${options.language}`
                        : '';
    
                    // Execute whisper command
                    const whisperCmd = `${whisperPath} -m ${modelPath} -f "${audioPath}" ${deviceFlag} ${langFlag}`;
                    console.log(`Executing: ${whisperCmd}`);
    
                    const { stdout, stderr } = await execAsync(whisperCmd, { maxBuffer: 1024 * 1024 * 10 });
    
                    if (stderr) {
                        console.warn('Warning during transcription:', stderr);
                    }
    
                    return stdout.trim() || 'Transcription produced no text.';
                } else {
                    throw new Error('Whisper executable not found');
                }
            }
    
            // Fallback or unsupported provider
            else {
                console.warn(`Unsupported transcription provider: ${provider}`);
                return `Audio file extracted: ${audioPath}. No suitable transcription method available for provider: ${provider}.`;
            }
    
        } catch (error) {
            console.error('Error transcribing audio:', error);
    
            // Try fallback if original method fails
            if (options.provider !== 'assemblyai') {
                try {
                    console.log('Transcription failed, trying AssemblyAI as fallback...');
                    
                    // Update status callback if available
                    if (this.statusCallback) {
                        await this.statusCallback('Transcription failed, switching to AssemblyAI as fallback...');
                    }
                    
                    // Call recursively with AssemblyAI as provider
                    return await this.transcribeAudio(audioPath, {
                        ...options,
                        provider: 'assemblyai'
                    });
                } catch (fallbackError) {
                    console.error('Fallback transcription also failed:', fallbackError);
                }
            }
    
            return `Error transcribing audio: ${error.message}. Please try again later.`;
        }
    }

    // In RumbleTool.ts, add this new helper method
    // Add the setter method
    public setStatusCallback(callback: StatusCallback | null): void {
        this.statusCallback = callback;
    }
    /**
     * Estimates transcription time based on file size and provider
     * @param fileSizeBytes File size in bytes
     * @param provider Transcription provider being used
     * @returns Estimated time in minutes
     */
    private estimateTranscriptionTime(fileSizeBytes: number, provider: TranscriptionProvider): number {
        // Convert bytes to MB for easier calculation
        const fileSizeMB = fileSizeBytes / (1024 * 1024);
        
        // Base speeds (MB per minute) for different providers
        // These are rough estimates based on observation and can be adjusted
        const processingSpeed: Record<string, number> = {
            'local-cuda': 15,    // RTX 3090 is fast - around 15MB/min
            'local-cpu': 5,      // CPU is slower - around 5MB/min
            'assemblyai': 10,    // AssemblyAI - around 10MB/min based on logs
            'google': 12         // Google - estimate based on their API
        };
        
        // Get appropriate speed or use assemblyai as fallback
        const speed = processingSpeed[provider] || processingSpeed.assemblyai;
        
        // Calculate time in minutes - ensure we have a reasonable minimum
        let estimatedMinutes = Math.max(1, fileSizeMB / speed);
        
        // Add a buffer for API latency and processing overhead
        estimatedMinutes += 1;
        
        // Round up to nearest 0.5 minute
        return Math.ceil(estimatedMinutes * 2) / 2;
    }
    private publishTranscriptionEstimate(videoId: string, fileSizeBytes: number, provider: string): void {
        try {
            const estimatedMinutes = this.estimateTranscriptionTime(fileSizeBytes, provider as TranscriptionProvider);
            
            // Store in the global map with a timestamp
            const estimate: TranscriptionEstimate = {
                videoId,
                estimatedMinutes,
                timestamp: Date.now()
            };
            
            (global as any).transcriptionEstimates = (global as any).transcriptionEstimates || new Map();
            (global as any).transcriptionEstimates.set(videoId, estimate);
            
            console.log(`[RumbleTool] Published transcription estimate: ${estimatedMinutes} minutes for ${videoId}`);
        } catch (error) {
            console.warn(`[RumbleTool] Error publishing estimate:`, error);
        }
    }

}
