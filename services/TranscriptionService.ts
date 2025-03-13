// services/TranscriptionService.ts
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import {
    TranscriptionProvider,
    TranscriptionOptions
} from '../commands/types';

const execAsync = promisify(exec);


export class TranscriptionService {
    private defaultProvider: TranscriptionProvider = 'local-cuda';
    private modelPath: string;
    private whisperPath: string;
    private apiKeys: Record<string, string> = {};

    constructor(config: {
        defaultProvider?: TranscriptionProvider;
        modelPath?: string;
        whisperPath?: string;
        apiKeys?: Record<string, string>;
    } = {}) {
        this.defaultProvider = config.defaultProvider || 'local-cuda';
        this.modelPath = config.modelPath || path.join(process.cwd(), 'models');
        this.whisperPath = config.whisperPath || '/usr/local/bin/whisper';
        this.apiKeys = config.apiKeys || {};
        
        // Create model directory if it doesn't exist
        if (!fs.existsSync(this.modelPath)) {
            fs.mkdirSync(this.modelPath, { recursive: true });
        }
        
        // Log available providers
        const availableProviders = ['local-cuda', 'local-cpu'];
        if (this.apiKeys['assemblyai'] && this.apiKeys['assemblyai'].length > 0) {
            availableProviders.push('assemblyai');
        }
        if (this.apiKeys['google'] && this.apiKeys['google'].length > 0) {
            availableProviders.push('google');
        }
        
        console.log(`TranscriptionService initialized with available providers: ${availableProviders.join(', ')}`);
    }

    public async transcribe(
        audioPath: string,
        options: TranscriptionOptions = {}
    ): Promise<string> {
        const provider = options.provider || this.defaultProvider;
        const modelSize = options.modelSize || 'medium';

        console.log(`Transcribing audio using ${provider} provider with ${modelSize} model`);

        switch (provider) {
            case 'local-cuda':
                return this.transcribeWithLocalCuda(audioPath, modelSize, options);
            case 'local-cpu':
                return this.transcribeWithLocalCpu(audioPath, modelSize, options);
            case 'assemblyai':
                return this.transcribeWithAssemblyAI(audioPath, options);
            case 'google':
                return this.transcribeWithGoogle(audioPath, options);
            default:
                throw new Error(`Unsupported transcription provider: ${provider}`);
        }
    }

    private async transcribeWithLocalCuda(
        audioPath: string,
        modelSize: string = 'medium',
        options: TranscriptionOptions = {}
    ): Promise<string> {
        try {
            // Ensure model exists
            const modelFile = path.join(this.modelPath, `ggml-${modelSize}.bin`);

            if (!fs.existsSync(modelFile)) {
                console.log(`Model file not found: ${modelFile}. Downloading...`);
                await this.downloadModel(modelSize);
            }

            // Set language parameter if specified
            const langParam = options.language ? `--language ${options.language}` : '';

            // Run whisper.cpp with CUDA
            const cmd = `${this.whisperPath} -m ${modelFile} -f ${audioPath} --device cuda ${langParam}`;
            console.log(`Executing: ${cmd}`);

            const { stdout, stderr } = await execAsync(cmd);

            if (stderr) {
                console.warn('Warning during transcription:', stderr);
            }

            return stdout.trim();
        } catch (error) {
            console.error('Error transcribing with local CUDA:', error);
            throw error;
        }
    }

    private async transcribeWithLocalCpu(
        audioPath: string,
        modelSize: string = 'base',
        options: TranscriptionOptions = {}
    ): Promise<string> {
        try {
            // Similar to CUDA but without the --device flag
            const modelFile = path.join(this.modelPath, `ggml-${modelSize}.bin`);

            if (!fs.existsSync(modelFile)) {
                console.log(`Model file not found: ${modelFile}. Downloading...`);
                await this.downloadModel(modelSize);
            }

            const langParam = options.language ? `--language ${options.language}` : '';

            // Run whisper.cpp on CPU
            const cmd = `${this.whisperPath} -m ${modelFile} -f ${audioPath} ${langParam}`;
            console.log(`Executing: ${cmd}`);

            const { stdout, stderr } = await execAsync(cmd);

            if (stderr) {
                console.warn('Warning during transcription:', stderr);
            }

            return stdout.trim();
        } catch (error) {
            console.error('Error transcribing with local CPU:', error);
            throw error;
        }
    }

    private async transcribeWithAssemblyAI(
        audioPath: string,
        options: TranscriptionOptions = {}
    ): Promise<string> {
        try {
            const apiKey = options.apiKey || this.apiKeys['assemblyai'];

            if (!apiKey) {
                throw new Error('AssemblyAI API key not provided');
            }

            // Read the audio file as a buffer
            const audioBuffer = fs.readFileSync(audioPath);

            // Step 1: Upload the audio file
            const uploadResponse = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Authorization': apiKey
                }
            });

            const audioUrl = uploadResponse.data.upload_url;
            console.log(`Uploaded audio to AssemblyAI: ${audioUrl}`);

            // Step 2: Submit for transcription
            const transcriptionResponse = await axios.post('https://api.assemblyai.com/v2/transcript', {
                audio_url: audioUrl,
                language_code: options.language || 'en'
            }, {
                headers: {
                    'Authorization': apiKey,
                    'Content-Type': 'application/json'
                }
            });

            const transcriptId = transcriptionResponse.data.id;
            console.log(`Transcription job submitted with ID: ${transcriptId}`);

            // Step 3: Poll for completion
            let result;
            while (true) {
                await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2 seconds

                const checkResponse = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
                    headers: {
                        'Authorization': apiKey
                    }
                });

                if (checkResponse.data.status === 'completed') {
                    result = checkResponse.data.text;
                    break;
                } else if (checkResponse.data.status === 'error') {
                    throw new Error(`AssemblyAI transcription failed: ${checkResponse.data.error}`);
                }

                console.log(`Transcription status: ${checkResponse.data.status}`);
            }

            return result;
        } catch (error) {
            console.error('Error transcribing with AssemblyAI:', error);
            throw error;
        }
    }

    private async transcribeWithGoogle(
        audioPath: string,
        options: TranscriptionOptions = {}
    ): Promise<string> {
        try {
            const apiKey = options.apiKey || this.apiKeys['google'];

            if (!apiKey) {
                throw new Error('Google API key not provided');
            }

            // This is a simplified example - in practice you'd need to use the Google Cloud client library
            // Here we're just showing the general approach

            // Read the audio file and convert to base64
            const audioContent = fs.readFileSync(audioPath).toString('base64');

            // Call the Speech-to-Text API
            const response = await axios.post(
                `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
                {
                    config: {
                        encoding: 'LINEAR16',
                        sampleRateHertz: 16000,
                        languageCode: options.language || 'en-US',
                    },
                    audio: {
                        content: audioContent
                    }
                }
            );

            // Extract and return the transcript
            let transcript = '';
            if (response.data.results) {
                transcript = response.data.results
                    .map((result: any) => result.alternatives[0].transcript)
                    .join(' ');
            }

            return transcript;
        } catch (error) {
            console.error('Error transcribing with Google:', error);
            throw error;
        }
    }

    private async downloadModel(modelSize: string): Promise<void> {
        try {
            const modelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelSize}.bin`;
            const modelPath = path.join(this.modelPath, `ggml-${modelSize}.bin`);

            console.log(`Downloading model from ${modelUrl}...`);

            // Use wget or curl to download the model
            await execAsync(`wget ${modelUrl} -O ${modelPath} || curl -L ${modelUrl} -o ${modelPath}`);

            console.log(`Model downloaded to ${modelPath}`);
        } catch (error) {
            console.error('Error downloading model:', error);
            throw error;
        }
    }
}