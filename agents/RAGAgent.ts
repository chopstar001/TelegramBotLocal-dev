// RAGAgent.ts
import { BaseAgent } from './BaseAgent';
import { BaseMessage } from '@langchain/core/messages';
import { ConversationManager } from '../ConversationManager';
import { ToolManager } from '../ToolManager';
import { PromptManager } from '../PromptManager';
import { InteractionType, EnhancedResponse, SourceCitation, DocumentMetadata } from '../commands/types';
import { ContextAdapter } from '../ContextAdapter';


export class RAGAgent extends BaseAgent {
    private removeDisclaimers: boolean;
    private ragModeStatus: Map<string, boolean> = new Map();
    private flowId: string;
    public setConversationManager(manager: ConversationManager): void {
        this.conversationManager = manager;
        console.log(`[RAGAgent:${this.flowId}] ConversationManager set successfully`);
    }
    constructor(
        flowId: string,
        conversationManager: ConversationManager | null,
        toolManager: ToolManager,
        promptManager: PromptManager,
        removeDisclaimers: boolean = true
    ) {
        super(conversationManager, toolManager, promptManager);
        this.removeDisclaimers = removeDisclaimers;
        this.flowId
    }

    
    getAgentName(): string {
        return "RAGAgent";
    }

    async cleanup(): Promise<void> {
        console.log(`[RAGAgent] Cleaning up resources`);
    }

    public async processQuery(
        input: string,
        context: string,
        chatHistory: BaseMessage[],
        interactionType: InteractionType,
        userId: string,
        adapter: ContextAdapter,
        progressKey?: string,
    ): Promise<EnhancedResponse> {
        const methodName = 'processQuery';
        console.log(`[${methodName}] Starting RAG query processing:`, {
            inputPreview: input.substring(0, 50),
            hasContext: !!context,
            contextLength: context?.length || 0,
            chatHistoryLength: chatHistory.length,
            userId
        });
    
        if (!this.conversationManager) {
            return {
                response: ["RAG system is not initialized"],
                sourceCitations: undefined,
                followUpQuestions: undefined,
                externalAgentSuggestion: undefined,
                gameMetadata: {
                    gameState: null,
                    keyboard: null
                }
            };
        }
    
        if (progressKey && adapter) {
            console.log(`[${methodName}:${this.flowId}] Updating progress: Preparing response`);
            await this.updateProgress(adapter, progressKey, "☕️");
        }
    
        const isRAGEnabled = this.isRAGModeEnabled(userId);
        const shouldUseRAG = this.shouldUseRAG(interactionType, isRAGEnabled);
    
        console.log(`[${methodName}] RAG status:`, {
            isRAGEnabled,
            shouldUseRAG,
            userId
        });
    
        let response = await this.conversationManager.generateResponse(
            input, 
            chatHistory, 
            false, 
            userId, 
            adapter
        );
    
        // Ensure response is an array of strings
        let responseArray = Array.isArray(response) ? response : [response];
    
        if (shouldUseRAG && this.removeDisclaimers) {
            console.log(`[${methodName}] Removing disclaimers from response`);
            responseArray = this.removeDisclaimersAndNotes(responseArray);
        }
    
        if (progressKey && adapter) {
            console.log(`[${methodName}:${this.flowId}] Updating progress: Preparing response`);
            await this.updateProgress(adapter, progressKey, "📚");
        }
    
        if (this.conversationManager.shouldPostProcess(input, interactionType)) {
            if (progressKey && adapter) {
                console.log(`[${methodName}:${this.flowId}] Updating progress: Applying post processing`);
                await this.updateProgress(adapter, progressKey, "🧐 Applying post processing...✈️");
            }
            response = [await this.conversationManager.postProcessResponse(response[0], input, interactionType)];
        }
    
        let sourceCitations: SourceCitation[] | undefined;
        let followUpQuestions: string[] | undefined;
    
        if (shouldUseRAG) {
            try {
                console.log(`[${methodName}] Generating source citations for context`);
                sourceCitations = await this.generateSourceCitations(context);
                console.log(`[${methodName}] Generated citations:`, {
                    count: sourceCitations?.length || 0,
                    firstCitation: sourceCitations?.[0]?.text.substring(0, 50)
                });
            } catch (error) {
                console.error(`[${methodName}] Error generating citations:`, error);
            }
    
            try {
                console.log(`[${methodName}] Generating follow-up questions`);
                followUpQuestions = await this.conversationManager.generateFollowUpQuestions(
                    context, 
                    chatHistory, 
                    true
                );
                console.log(`[${methodName}] Generated follow-up questions:`, {
                    count: followUpQuestions?.length || 0,
                    firstQuestion: followUpQuestions?.[0]?.substring(0, 50)
                });
            } catch (error) {
                console.error(`[${methodName}] Error generating follow-up questions:`, error);
            }
        }
    
        const enhancedResponse: EnhancedResponse = {
            response: responseArray,
            sourceCitations,
            followUpQuestions,
            externalAgentSuggestion: shouldUseRAG ? 
                await this.checkForExternalAgentAssistance(input, responseArray.join('\n')) : 
                undefined,
            gameMetadata: {
                gameState: null,
                keyboard: null
            }
        };
    
        console.log(`[${methodName}] Final enhanced response:`, {
            responseLength: enhancedResponse.response.length,
            hasCitations: !!enhancedResponse.sourceCitations && enhancedResponse.sourceCitations.length > 0,
            citationsCount: enhancedResponse.sourceCitations?.length || 0,
            hasFollowUps: !!enhancedResponse.followUpQuestions && enhancedResponse.followUpQuestions.length > 0,
            followUpsCount: enhancedResponse.followUpQuestions?.length || 0,
            shouldUseRAG
        });
    
        return enhancedResponse;
    }
    public removeDisclaimersAndNotes(response: string[]): string[] {
        if (!this.removeDisclaimers) {
            return response; // Return the original response if removeDisclaimers is false
        }
        const disclaimerPhrases = [
            "it's important to note",
            "it's worth mentioning",
            "please note",
            "note:",
            "disclaimer:",
            "keep in mind",
            "it should be noted",
            "it is crucial to understand",
            "it is essential to remember",
            "be aware that",
            "remember that",
            "important:",
            "caution:",
            "warning:",
            "sovereign citizens",
            "sovereign citizen",
            "allegedly",
            "it's crucial to understand",
            "it's essential to remember",
        ];

        return response.map(paragraph => {
            let modifiedParagraph = paragraph;
            
            disclaimerPhrases.forEach(phrase => {
                const regex = new RegExp(`(?<=\\.|^)\\s*.*${phrase}.*?(?=\\.|$)`, 'gi');
                modifiedParagraph = modifiedParagraph.replace(regex, '');
            });

            modifiedParagraph = modifiedParagraph.replace(/(?<=\.|^)\s*(However,|Although,).*?(?=\\.|$)/gi, '');
            return modifiedParagraph.trim();
        }).filter(paragraph => paragraph.length > 0);
    }

    public isRAGModeEnabled(userId: string): boolean {
        return this.ragModeStatus.get(userId) || false;
    }
    
    public toggleRAGMode(userId: string, enable: boolean): void {
        this.ragModeStatus.set(userId, enable);
        console.log(`RAG mode ${enable ? 'enabled' : 'disabled'} for user ${userId}`);
    }

    setRemoveDisclaimers(remove: boolean): void {
        this.removeDisclaimers = remove;
        console.log(`Disclaimer removal in RAG mode ${remove ? 'enabled' : 'disabled'}`);
    }

    private shouldUseRAG(interactionType: InteractionType, isRAGEnabled: boolean): boolean {
        if (isRAGEnabled) {
            return Math.random() < 0.8 || this.isComplexQuery(interactionType);
        }
        return this.isComplexQuery(interactionType);
    }

    private isComplexQuery(interactionType: InteractionType): boolean {
        return interactionType === 'explanatory_question' || interactionType === 'factual_question';
    }
    private async updateProgress(adapter: ContextAdapter, progressKey: string, stage: string): Promise<boolean> {
        if (adapter.isTelegramMessage()) {
            console.log(`[ConversationManager:${this.flowId}] Updating progress: ${stage}`);
            return await adapter.updateProgress(this.flowId, progressKey, stage);
        }
        return false;
    }
    
    
    private async generateSourceCitations(context: string | undefined): Promise<SourceCitation[]> {
        if (!context) {
            console.warn("[generateSourceCitations] Received undefined context");
            return [];
        }
    
        const documentBlocks = context.split(/(?=\[Relevance:)/g).filter(block => block.trim().length > 0);
        //console.log(`[generateSourceCitations] Found ${documentBlocks.length} document blocks.`);
    
        const documents = documentBlocks.map((block, index) => {
           // console.log(`[generateSourceCitations] Processing document block ${index + 1}:`, block.substring(0, 100) + '...');
            return this.parseDocumentBlock(block);
        });
    
        const sortedDocuments = documents.sort((a, b) => b.relevance - a.relevance);
    
        const citations: SourceCitation[] = sortedDocuments.slice(0, 8).map((doc, index) => {
            const citation: SourceCitation = {
                author: this.trimField(doc.metadata.author || 'Unknown author', 50),
                title: this.trimField(doc.metadata.title || 'Untitled', 100),
                fileName: doc.metadata.fileName || 'Unknown file',
                chunkOrder: doc.metadata.chunk_order ?? 0,
                relevance: doc.relevance,
                text: this.formatCitationText(doc.metadata, index + 1, doc.relevance),
                source: doc.metadata.fileName || 'Unknown file',
                lines: 'N/A',
                content: 'N/A'
            };
            
            console.log(`[generateSourceCitations] Generated citation ${index + 1}:`, citation);
            return citation;
        });
    
        console.log("[generateSourceCitations] Final citations:", citations);
        return citations;
    }
    
    private formatCitationText(metadata: DocumentMetadata, index: number, relevance: number): string {
        const author = this.trimField(metadata.author || 'Unknown author', 50);
        const title = this.trimField(metadata.title || 'Untitled', 100);
        const fileName = metadata.fileName || 'Unknown file';
        const chunkOrder = metadata.chunk_order ?? 0;
        return `[${index}] ${author}: "${title}", File: ${fileName}, Chunk: ${chunkOrder}, Relevance: ${relevance.toFixed(3)}`;
    }
    
    private trimField(field: string, maxLength: number): string {
        return field.length <= maxLength ? field : field.substring(0, maxLength - 3) + '...';
    }
    
    private parseDocumentBlock(block: string): { content: string; metadata: DocumentMetadata; relevance: number } {
        const relevanceMatch = block.match(/\[Relevance: ([\d.]+)\]/);
        const relevance = relevanceMatch ? parseFloat(relevanceMatch[1]) : 0;
    
        // Remove the relevance line if it exists
        let contentAndMetadata = relevanceMatch ? block.replace(relevanceMatch[0], '').trim() : block;
    
        // Split content and metadata
        const metadataSplit = contentAndMetadata.split('--- Metadata: ');
        const content = metadataSplit[0].trim();
        const metadataStr = metadataSplit[1] ? metadataSplit[1].trim() : '';
    
        let metadata: DocumentMetadata = {
            author: 'Unknown',
            title: 'Untitled',
            fileName: 'Unknown file'
        };
    
        if (metadataStr) {
            try {
                const parsedMetadata = JSON.parse(metadataStr);
                metadata = { ...metadata, ...parsedMetadata };
            } catch (error) {
                console.warn("[parseDocumentBlock] Error parsing metadata:", error);
            }
        }
    
        // If no title in metadata, use the first 50 characters of content as title
        if (metadata.title === 'Untitled' && content) {
            metadata.title = content.split('.')[0].trim().substring(0, 50);
            if (metadata.title.length === 50) metadata.title += '...';
        }
    
        return { content, metadata, relevance };
    }


    private async checkForExternalAgentAssistance(input: string, response: string): Promise<string | null> {
        // Implementation for checking if external agent assistance is needed
        return null;
    }
}