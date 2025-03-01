// TelegramBot_Agents.ts

import { ICommonObject, INode, INodeData, INodeParams, FlowiseMemory, IVisionChatModal, IMessage as FlowiseIMessage, MessageType } from '../../../src/Interface';
import { Telegraf, Context, Markup } from 'telegraf';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage, MessageContent } from '@langchain/core/messages';
import { VectorStore } from '@langchain/core/vectorstores';
import { Update, User, Chat, Message } from 'telegraf/typings/core/types/typegram';
import { ExtraReplyMessage } from 'telegraf/typings/telegram-types';
import {
    logDebug,
    logInfo,
    logWarn,
    logError,
    logMessageProcessingStart,
    logChatHistory
} from './loggingUtility';
import { BaseRetriever } from '@langchain/core/retrievers';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Tool } from 'langchain/tools';
import { Document } from 'langchain/document';
import { ChatMember } from 'telegraf/typings/core/types/typegram';
import { ConversationManager } from './ConversationManager';
import { CustomRetriever, DummyRetriever } from './CustomRetriever';
import { getBaseClasses, getCredentialData, getCredentialParam } from '../../../src/utils';
import { CommandHandler } from './CommandHandler';
import { MemoryManager } from './MemoryManager';
import { MemoryType, BotInfo, IExtendedMemory, ExtendedIMessage, IUpdateMemory, GroupMemberInfo, UserQuestionData, MessageContext, AuthRequest, TelegramAuthData, SessionData, WalletAuthData, UserAccount, UserDataRetriever, UserStats, WebAuthResponse, WebAuthData, SafeOptions, FormattedResponse, SessionInfo, ChatRequest, WebappChatIdData, type ConversationOperation, ConversationMetadata, RateLimits, RawMessageInput, SavedConversation, ConversationMessage } from './commands/types';
import { messageContentToString } from './utils/utils';
import { addImagesToMessages, llmSupportsVision } from '../../../src/multiModalUtils';
import ToolManager from './ToolManager';
import PromptManager from './PromptManager';
import { AgentManager } from './AgentManager';
import { ContextAdapter } from './ContextAdapter';
import { RAGAgent } from './agents/RAGAgent';
import { MenuManager } from './MenuManager';
import { AccountManager } from './AccountManager';
import { FormatConverter } from './utils/FormatConverter';
import { handleNonTelegramMessage } from './handleNonTelegramMessage';
import { InteractionType, EnhancedResponse, SourceCitation, UserCitationData, PatternContextData } from './commands/types';
import { v4 as uuidv4 } from 'uuid';
import { formatResponse } from '../../outputparsers/OutputParserHelpers';
import { streamResponse } from '../../moderation/Moderation';
import NodeCache from 'node-cache';
import { Mutex } from 'async-mutex';
import {
    DatabaseService,
    AUTH_TYPES,
    SUBSCRIPTION_TIERS,
    type AuthType,
    type SubscriptionTier,
    type CreateUserDTO,
    type UserData
} from './services/DatabaseService';
import { AuthService } from './services/AuthService';
import { LifelineType, GameState } from './commands/types';
import { GameAgent } from './agents/GameAgent';
import { PatternPromptAgent } from './agents/PatternPromptAgent';



const botInstanceCache = new NodeCache({ stdTTL: 0, checkperiod: 600, useClones: false });
const botInitializationLocks: { [key: string]: Mutex } = {};
const flowIdMap = new Map<string, string>(); // Maps botKey to flowId

function getOrCreateFlowId(botKey: string): string {
    let flowId = flowIdMap.get(botKey);
    if (!flowId) {
        flowId = uuidv4();
        flowIdMap.set(botKey, flowId);
        console.log(`[FlowID: ${flowId}] Created new flowId for botKey ${botKey}`);
    } else {
        console.log(`[FlowID: ${flowId}] Retrieved existing flowId for botKey ${botKey}`);
    }
    return flowId;
}


interface INodeOutput {
    label: string;
    name: string;
    baseClasses: string[];
    condition?: (data: INodeData) => boolean;
}


type ExtendedMetadata = Record<string, any> & {
    processed?: boolean;
    originalLength?: number;
    processedLength?: number;
};
let response: AIMessage;
// Removed Singleton TestLogger for brevity

export class TelegramBot_Agents implements INode, IUpdateMemory {
    label: string;
    name: string;
    version: number;
    description: string;
    type: string;
    icon: string;
    category: string;
    baseClasses: string[];
    inputs: INodeParams[];
    outputs: INodeOutput[];
    credential: INodeParams;

    private updateProcess: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    private chatflowId: string | null = null;
    private chatflowPool: any; // We'll type this properly once we have access to the types
    private initializationPromise: Promise<void> | null = null;
    private lastUpdateId: number = 0;
    private isInitialized: boolean = false;
    private initializing: boolean = false;
    private commandHandler: CommandHandler;
    private conversationManager: ConversationManager | null = null;
    private retriever: BaseRetriever;
    private userDataRetriever: BaseRetriever | null = null;
    private chatModel: BaseChatModel;
    private SpModel: BaseChatModel;
    private summationModel: BaseChatModel;
    private utilityModel: BaseChatModel;
    private knownBotIds: Set<number> = new Set();
    private botToken: string;
    private botId: number | null = null;
    private knownBotUsernames: Set<string> = new Set(['BotB_username', 'AnotherBot_username']);
    private ragSystemPrompt: string | undefined;
    private gameSystemPrompt: string | undefined;
    private generalSystemPrompt: string | undefined;
    private humanMessageTemplate: string | undefined;
    private summarizeSystemPrompt: string | undefined;
    private gameSummarizeSystemPrompt: string | undefined;
    private welcomeMessage: string;
    private idleTimeout: number;
    private adminIds: number[] = [];
    private userLastActivity: Map<number, number> = new Map();
    private memory: IExtendedMemory | null = null;
    public bot: Telegraf<Context<Update>> | null = null;
    private agentManager: AgentManager;
    private collaboratingAgents: TelegramBot_Agents[] = [];
    private toolManager: ToolManager;
    public promptManager: PromptManager | null;
    private ragAgent: RAGAgent;
    private groupMembers: Map<number, Map<number, GroupMemberInfo>> = new Map();
    private botIds: number[] = [];
    private botInfo: BotInfo[];
    public menuManager: MenuManager;
    private awaitingQuestionSelection: Map<number, boolean> = new Map();
    private userQuestions: Map<number, UserQuestionData> = new Map();
    private userQuestionSets: Map<number, Map<string, UserQuestionData>> = new Map();
    private userCitationSets: Map<number, Map<string, UserCitationData>> = new Map();
    private tools: Tool[]
    public flowId: string; // Unique identifier for the flow
    private chatFlowMap: Map<number, string> = new Map(); // Maps chatId to flowId
    private progressMessages: Map<string, string> = new Map();
    private sentConfirmations: Map<string, number> = new Map();
    public readonly DEFAULT_TOKEN_QUOTA = 25000; // Adjust as needed
    private accountManager: AccountManager;
    public databaseService: DatabaseService;
    public authService: AuthService;
    private updateBuffer: Map<string, {
        updates: Context<Update>[];
        lastUpdate: number;
        processingTimer: NodeJS.Timeout | null;
    }> = new Map();

    private readonly MESSAGE_JOINING_WINDOW = 5000; // 5 seconds (up from 3)
    private readonly MAX_BUFFERED_UPDATES = 15; // Increased from 10



    public getToolManager(): ToolManager {
        return this.toolManager;
    }

    public getAccountManager(): AccountManager {
        return this.accountManager;
    }

    public getMemoryType(): IExtendedMemory | null {
        return this.memory;
    }

    public getAgentManager(): AgentManager | null {
        return this.agentManager || null;
    }

    constructor(flowId?: string) {
        this.chatflowId = this.chatflowId || null;
        this.chatflowPool = (global as any).chatflowPool;
        this.flowId = flowId || uuidv4();
        this.label = 'Telegram Bot with Retrieval Chain';
        this.name = 'telegramBotRetrievalChain';
        this.version = 1.0;
        this.type = 'TelegramBot';
        this.icon = 'telegram.svg';
        this.category = 'Agents';
        this.baseClasses = [this.type, 'Composer'];
        this.description = 'Versatile Telegram bot with optional RAG capabilities. Supports custom prompts, handles human/AI interactions. Ideal for customer service, information retrieval, and inter-bot communication. Requires Telegram API credentials.';
        this.credential = {
            label: 'Telegram API',
            name: 'telegramApi',
            type: 'credential',
            credentialNames: ['telegramApi']
        };
        this.inputs = [
            {
                label: 'Memory',
                name: 'memory',
                type: 'BaseChatMemory',
                optional: true
            },
            {
                label: 'Chat Model',
                name: 'chatModel',
                type: 'BaseChatModel',
                optional: false
            },
            {
                label: 'Special Purpose Model',
                name: 'SpModel',
                type: 'BaseChatModel',
                optional: true
            },
            {
                label: 'Summation Model',
                name: 'summationModel',
                type: 'BaseChatModel',
                optional: true
            },
            {
                label: 'Utility Model',
                name: 'utilityModel',
                type: 'BaseChatModel',
                optional: true
            },
            {
                label: 'Retriever',
                name: 'retriever',
                type: 'BaseRetriever',
                optional: true
            },
            {
                label: 'Tools',
                name: 'tools',
                type: 'Tool',
                list: true,
                optional: true
            },
            {
                label: 'Admin User IDs',
                name: 'adminIds',
                type: 'string',
                description: 'Comma-separated list of Telegram user IDs who can use admin commands',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Bot Information',
                name: 'botInfo',
                type: 'string',
                description: 'Comma-separated list of bot information in format: botId:botFirstName:botUsername',
                optional: true,
                additionalParams: true
            },
            {
                label: 'RAG System Prompt',
                name: 'ragSystemPrompt',
                type: 'string',
                rows: 4,
                placeholder: PromptManager.defaultRAGSystemPrompt(),
                optional: true,
                additionalParams: true
            },
            {
                label: 'General System Prompt',
                name: 'generalSystemPrompt',
                type: 'string',
                rows: 4,
                placeholder: PromptManager.defaultGeneralSystemPrompt(),
                optional: true,
                additionalParams: true
            },
            {
                label: 'Human Message Template',
                name: 'humanMessageTemplate',
                type: 'string',
                rows: 2,
                placeholder: PromptManager.defaultHumanMessageTemplate(),
                optional: true,
                additionalParams: true
            },
            {
                label: 'Persona Prompt',
                name: 'personaPrompt',
                type: 'string',
                rows: 4,
                placeholder: PromptManager.defaultPersonaPrompt(),
                optional: true,
                additionalParams: true
            },
            {
                label: 'Enable Persona',
                name: 'enablePersona',
                type: 'boolean',
                default: false,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Summarize System Prompt',
                name: 'summarizeSystemPrompt',
                type: 'string',
                rows: 4,
                placeholder: PromptManager.defaultSummarizeSystemPrompt(),
                optional: true,
                additionalParams: true
            },
            {
                label: 'Game Summarize System Prompt',
                name: 'gameSummarizeSystemPrompt',
                type: 'string',
                rows: 6,
                placeholder: PromptManager.defaultGameSummarizeSystemPrompt(),
                optional: true,
                additionalParams: true
            },
            {
                label: 'Game System Prompt',
                name: 'gameSyetemPrompt',
                type: 'string',
                rows: 6,
                placeholder: PromptManager.defaultGameSystemPrompt(),
                optional: true,
                additionalParams: true
            },
            {
                label: 'Tool Agent System Prompt',
                name: 'toolAgentSystemPrompt',
                type: 'string',
                rows: 6,
                optional: true,
                additionalParams: true,
                placeholder: PromptManager.defaultToolAgentSystemPrompt()
            },
            {
                label: 'Summarize System Prompt [AI summary guidelines]',
                name: 'maxMessageLength',
                type: 'number',
                default: 4000,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Remove Disclaimers in RAG Mode',
                name: 'removeDisclaimersRAG',
                type: 'boolean',
                default: true,
                description: 'When enabled, removes disclaimers and notes from RAG responses',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Dynamic Context Base Length [Initial context size]',
                name: 'dynamicContextBaseLength',
                type: 'number',
                default: 7000,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Minimum Complexity Factor [Context scaling (0-1)]',
                name: 'minComplexityFactor',
                type: 'number',
                step: 0.1,
                default: 0.9,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Max Chat History Tokens [Conversation memory limit]',
                name: 'maxChatHistoryTokens',
                type: 'number',
                default: 4000,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Top Relevant Documents [Max docs for context]',
                name: 'topRelevantDocs',
                type: 'number',
                default: 15,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Relevance Score Threshold [Min. relevance for inclusion (0-1)]',
                name: 'relevanceScoreThreshold',
                type: 'number',
                step: 0.02,
                default: 0.1,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Context Window Size [Max context tokens]',
                name: 'contextWindowSize',
                type: 'number',
                default: 6000,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Welcome Message [Initial bot greeting]',
                name: 'welcomeMessage',
                type: 'string',
                rows: 2,
                placeholder: 'Welcome! How can I assist you today?',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Idle Timeout [Session expiry time (seconds)]',
                name: 'idleTimeout',
                type: 'number',
                default: 300,
                optional: true,
                additionalParams: true
            },
        ]
        this.inputs.push(
            {
                label: 'Collaborating Agents',
                name: 'collaborators',
                type: 'TelegramBot_Agents',
                list: true,
                optional: true
            },
            {
                label: 'Default Token Quota',
                name: 'defaultTokenQuota',
                type: 'number',
                default: 10000,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Auth Secret Key',
                name: 'authSecret',
                type: 'password',
                optional: true,
                additionalParams: true
            }
        );
    }


    public async init(nodeData: INodeData, flowData: string, options: ICommonObject): Promise<void> {
        console.log(`[Init entered:] Looking to Initialize`);

        try {
            // Initialize database first
            this.databaseService = new DatabaseService(this.flowId);
            await this.databaseService.initialize();

            // This method already creates all necessary tables in the correct order
            await this.databaseService.createBotTables();
            // Initialize AuthService after DatabaseService
            this.authService = new AuthService(this.databaseService);

            // Initialize other services that depend on database
            this.accountManager = new AccountManager(
                this.databaseService,
                this.conversationManager!,
                this.flowId,
                nodeData.inputs?.defaultTokenQuota as number,
                this.authService
            );

            logInfo('init', 'Services initialized successfully', {
                hasDatabase: !!this.databaseService,
                hasAccountManager: !!this.accountManager
            });
        } catch (error) {
            logError('init', 'Error initializing services:', error as Error);
            // Reset state on error
            this.isInitialized = false;
            this.isRunning = false;
            throw error;
        }

        if (this.initializing) {
            console.log(`[FlowID: ${this.flowId}] Initialization in progress. Awaiting completion.`);
            return this.initializationPromise!;
        }

        if (this.isInitialized) {
            console.log(`[FlowID: ${this.flowId}] Already initialized. Skipping initialization.`);
            return;
        }

        this.initializing = true;

        const chatflowid = options.chatflowid || 'default_chatflow';

        // Use chatflowid as the unique identifier for botKey
        const botKey = chatflowid;
        const flowId = getOrCreateFlowId(botKey);
        this.flowId = flowId;

        // Store the instance in cache
        if (botKey) {
            botInstanceCache.set(botKey, this);
            console.log(`Bot instance stored in cache with key: ${botKey}`);
        } else {
            console.warn('Bot key is undefined. Bot instance will not be cached.');
        }




        this.initializationPromise = this.performInitialization(nodeData, flowData, options)
            .then(() => {
                this.isInitialized = true;
                console.log(`[FlowID: ${this.flowId}] Initialization completed successfully`);
            })
            .catch((error) => {
                if (error.code === 409) {
                    console.warn(`[FlowID: ${this.flowId}] Bot is already running. Setting isInitialized to true.`);
                    this.isInitialized = true;
                } else {
                    this.isInitialized = false;
                    console.error(`[FlowID: ${this.flowId}] Initialization failed:`, error);
                    throw error;
                }
            })
            .finally(() => {
                this.initializing = false;
                this.initializationPromise = null;
                console.log(`[FlowID: ${this.flowId}] Initialization promise cleared.`);
            });

        return this.initializationPromise;
    }



    private async performInitialization(nodeData: INodeData, flowData: string, options: ICommonObject, interactionType?: InteractionType): Promise<void> {
        const methodName = 'performInitialization';

        try {
            // Add early validation
            if (!nodeData) {
                console.log(`[${methodName}] No nodeData provided`);
                return;
            }
            // Safe access to nodeData
            const inputs = nodeData.inputs || {};
            const credential = nodeData.credential || {};

            logInfo(methodName, 'Starting initialization with:', {
                flowId: this.flowId,
                hasInputs: Object.keys(inputs).length > 0,
                hasCredential: Object.keys(credential).length > 0
            });

            console.log("Starting initialization of TelegramBot_Agents node");
            console.log("Node inputs:", nodeData.inputs);

            console.log("Checking inputs...");
            // In performInitialization method

            /**
             * Initialize chat models with proper error handling and fallbacks
             */
            // Initialize primary chat model (required)
            this.chatModel = nodeData.inputs?.chatModel as BaseChatModel;
            if (!this.chatModel) {
                throw new Error('Missing required input: chatModel');
            }

            // Initialize special purpose model with fallback to chatModel
            this.SpModel = nodeData.inputs?.SpModel as BaseChatModel;
            if (!this.SpModel) {
                console.warn('No separate SpModel provided. Using chatModel as fallback.');
                this.SpModel = this.chatModel;
            }

            // Initialize summation model with fallback
            this.summationModel = nodeData.inputs?.summationModel as BaseChatModel;
            if (!this.summationModel) {
                console.warn('No separate summation model provided. Using chatModel for summation tasks.');
                this.summationModel = this.chatModel;
            }

            // Initialize utility model with fallback
            this.utilityModel = nodeData.inputs?.utilityModel as BaseChatModel;
            if (!this.utilityModel) {
                console.warn('No separate utilityModel model provided. Using chatModel for utility tasks.');
                this.utilityModel = this.chatModel;
            }

            // Initialize memory
            console.log("Memory input:", nodeData.inputs?.memory);
            if (nodeData.inputs?.memory) {
                console.log("External memory provided:", nodeData.inputs.memory);
                this.memory = this.adaptMemory(nodeData.inputs.memory);
            } else {
                console.log("No external memory provided, using MemoryManager");
                this.memory = new MemoryManager();
            }
            console.log("Memory type:", this.memory.getMemoryType());
            console.log("Initialized memory:", this.memory.constructor.name);
            console.log(this.memory ? "Using provided memory solution." : "No memory solution provided. Using default or none.");
            this.promptManager = new PromptManager(
                nodeData.inputs?.ragSystemPrompt as string || PromptManager.defaultRAGSystemPrompt(),
                nodeData.inputs?.generalSystemPrompt as string || PromptManager.defaultGeneralSystemPrompt(),
                nodeData.inputs?.humanMessageTemplate as string || PromptManager.defaultHumanMessageTemplate(),
                nodeData.inputs?.summarizeSystemPrompt as string || PromptManager.defaultSummarizeSystemPrompt(),
                nodeData.inputs?.gameSummarizeSystemPrompt as string || PromptManager.defaultGameSummarizeSystemPrompt(),
                nodeData.inputs?.personaPrompt as string || PromptManager.defaultPersonaPrompt(),
                nodeData.inputs?.toolAgentSystemPrompt as string || PromptManager.defaultToolAgentSystemPrompt(),
                nodeData.inputs?.gameSystemPrompt as string || PromptManager.defaultGameSystemPrompt(), // Moved to correct position
                nodeData.inputs?.maxChatHistoryTokens as number || 3000,
                nodeData.inputs?.maxMessageLength as number || 4000,
                nodeData.inputs?.enablePersona as boolean || false
            );
            // Initialize system prompts
            this.ragSystemPrompt = nodeData.inputs?.ragSystemPrompt as string || PromptManager.defaultRAGSystemPrompt();
            this.generalSystemPrompt = nodeData.inputs?.generalSystemPrompt as string || PromptManager.defaultGeneralSystemPrompt();
            this.humanMessageTemplate = nodeData.inputs?.humanMessageTemplate as string || PromptManager.defaultHumanMessageTemplate();
            this.summarizeSystemPrompt = nodeData.inputs?.summarizeSystemPrompt as string || PromptManager.defaultSummarizeSystemPrompt();
            this.gameSummarizeSystemPrompt = nodeData.inputs?.gameSummarizeSystemPrompt as string || PromptManager.defaultGameSummarizeSystemPrompt();

            this.gameSystemPrompt = nodeData.inputs?.gameSystemPrompt as string || PromptManager.defaultGameSystemPrompt();

            // Extract tools from nodeData.inputs.tools
            const tools: Tool[] = nodeData.inputs?.tools as Tool[] || [];

            if (tools.length === 0) {
                logWarn('performInitialization', 'No tools provided in nodeData.inputs.tools. Initializing with an empty array.');
            } else {
                logInfo('performInitialization', `Tools provided: ${tools.map(tool => tool.name).join(', ')}`);
            }

            // Initialize ToolManager with the extracted tools
            this.toolManager = new ToolManager(tools);

            // Initialize other parameters
            const removeDisclaimersRAG = nodeData.inputs?.removeDisclaimersRAG as boolean ?? false; // Set to false by default
            const maxMessageLength = nodeData.inputs?.maxMessageLength as number || 4000;
            const dynamicContextBaseLength = nodeData.inputs?.dynamicContextBaseLength as number || 7000;
            const minComplexityFactor = nodeData.inputs?.minComplexityFactor as number || 0.9;
            const maxChatHistoryTokens = nodeData.inputs?.maxChatHistoryTokens as number || 4000;
            const topRelevantDocs = nodeData.inputs?.topRelevantDocs as number || 40;
            const relevanceScoreThreshold = nodeData.inputs?.relevanceScoreThreshold as number || 0.2;
            const contextWindowSize = nodeData.inputs?.contextWindowSize as number || 6000;
            const welcomeMessage = nodeData.inputs?.welcomeMessage as string || 'Welcome! How can I assist you today?';
            const idleTimeout = nodeData.inputs?.idleTimeout as number || 300;
            const toolAgentSystemPrompt = nodeData.inputs?.toolAgentSystemPrompt as string || PromptManager.defaultToolAgentSystemPrompt();

            this.agentManager = new AgentManager(this.flowId, this.toolManager, this.promptManager);

            this.menuManager = new MenuManager(this, this.flowId); // Pass flowId as string



            // Initialize Bot and Admin IDs
            const botInfoInput = nodeData.inputs?.botInfo as string | undefined;
            console.log('Bot info input:', botInfoInput);
            this.botInfo = this.parseBotInfoInput(botInfoInput);
            console.log('Parsed bot info:', this.botInfo);


            // Extract bot IDs from botInfo for backward compatibility
            this.botIds = this.botInfo.map(bot => bot.id);
            console.log('Extracted bot IDs:', this.botIds);

            // Parse admin IDs
            const adminIdsInput = nodeData.inputs?.adminIds as string;
            this.adminIds = adminIdsInput ? adminIdsInput.split(',').map(id => parseInt(id.trim())) : [];                //const adminIds = adminIdsInput ? adminIdsInput.split(',').map(id => parseInt(id.trim())) : [];
            // Handle vision capabilities
            if (llmSupportsVision(this.chatModel)) {
                const visionChatModel = this.chatModel as IVisionChatModal;
                const messageContent = await addImagesToMessages(nodeData, options, visionChatModel.multiModalOption);
                if (messageContent?.length) {
                    visionChatModel.setVisionModel();
                    // Update the system message or prompt to include vision capabilities
                } else {
                    visionChatModel.revertToOriginalModel();
                }
            }

            // Handle retrievers
            this.userDataRetriever = nodeData.inputs?.userDataStore as BaseRetriever;
            if (this.userDataRetriever) {
                console.log('User data store initialized');
            }

            if (nodeData.inputs?.retriever) {
                console.log("Using provided retriever with enhanced logging.");
                const topRelevantDocs = nodeData.inputs?.topRelevantDocs as number || 10;
                const retriever = nodeData.inputs.retriever as BaseRetriever;

                // Try to get vectorStore from the retriever if it's available
                const vectorStore = (retriever as any).vectorStore ||
                    (retriever as any).client ||
                    (retriever as any).store;

                if (!vectorStore) {
                    console.error("Could not find vectorStore in retriever. Cannot initialize CustomRetriever.");
                    console.log("Retriever type:", retriever.constructor.name);
                    console.log("Available properties:", Object.keys(retriever));
                    this.retriever = new DummyRetriever();
                } else {
                    this.retriever = new CustomRetriever({
                        retriever: retriever,
                        vectorStore: vectorStore,
                        topRelevantDocs: topRelevantDocs,
                        postProcessor: this.postProcessDocuments.bind(this),
                        chatModel: this.chatModel,
                        summationModel: this.summationModel,
                        utilityModel: this.utilityModel,
                        verbose: nodeData.inputs.verbose || true,
                    });
                }
            } else {
                console.log("No retriever provided. Using DummyRetriever. RAG functionality will be limited.");
                this.retriever = new DummyRetriever();
            }

            console.log("Initializing TelegramBot_Agents with inputs:", {
                inputKeys: Object.keys(nodeData.inputs || {}),
                hasMemory: !!nodeData.inputs?.memory,
                hasChatModel: !!nodeData.inputs?.chatModel,
                hasSummationModel: !!nodeData.inputs?.summationModel,
                hasRetriever: !!nodeData.inputs?.retriever,
                hasTools: Array.isArray(nodeData.inputs?.tools) ? nodeData.inputs.tools.length : 0,
                adminIds: nodeData.inputs?.adminIds,
                botInfo: nodeData.inputs?.botInfo,
                // Include other safe-to-log properties as needed
            });

            //And we the bots, shall...., Collaborate!
            // In performInitialization method
            if (nodeData.inputs?.collaborators) {
                const collaboratorsData = nodeData.inputs.collaborators as INodeData[];
                for (const collaboratorData of collaboratorsData) {
                    const collaboratorFlowId = uuidv4(); // Generate unique flowId for collaborator
                    const collaboratorBot = new TelegramBot_Agents(collaboratorFlowId);
                    await collaboratorBot.init(collaboratorData, flowData, options);
                    this.collaboratingAgents.push(collaboratorBot);

                    const collaboratorAgentManager = new AgentManager(collaboratorFlowId, this.toolManager, this.promptManager);
                    this.agentManager.addCollaborator(collaboratorAgentManager);

                    // Correct method call
                    collaboratorAgentManager.setTelegramBot(collaboratorBot);

                    console.log(`[FlowID: ${this.flowId}] Collaborating agent initialized with FlowID: ${collaboratorFlowId}`);
                }
            }

            // Initialize MemoryManager and ConversationManager
            //const memoryManager = new MemoryManager();

            console.log('Initializing ConversationManager...');
            this.conversationManager = new ConversationManager({
                retriever: this.retriever,
                userDataRetriever: this.userDataRetriever,
                chatModel: this.chatModel,
                SpModel: this.SpModel,
                summationModel: this.summationModel,
                utilityModel: this.utilityModel,
                tools: this.tools,
                welcomeMessage: nodeData.inputs?.welcomeMessage as string || 'Welcome! How can I assist you today?',
                maxMessageLength,
                dynamicContextBaseLength,
                minComplexityFactor,
                maxChatHistoryTokens,
                topRelevantDocs,
                relevanceScoreThreshold,
                contextWindowSize,
                adminIds: this.adminIds,
                enablePersona: nodeData.inputs?.enablePersona as boolean || false,
                toolAgentSystemPrompt: nodeData.inputs?.toolAgentSystemPrompt as string || PromptManager.defaultToolAgentSystemPrompt(),
                agentManager: this.agentManager,
                promptManager: this.promptManager,
                flowId: this.flowId,
                flowIdMap: flowIdMap,
                databaseService: this.databaseService

            });
            console.log("Initialized memory:", this.memory.constructor.name);
            this.ragAgent = new RAGAgent(
                this.flowId,
                this.conversationManager,
                this.toolManager,
                this.promptManager,
                removeDisclaimersRAG
            );
            if (this.agentManager) {
                if (!this) {
                    console.warn('TelegramBot not initialized when creating GameAgent');
                    return;
                }
                const toolManager = this.getToolManager();
                if (!toolManager) {
                    console.warn('ToolManager not available when creating GameAgent');
                    return;
                }
                const gameAgent = new GameAgent(
                    this.flowId,
                    this.conversationManager,
                    toolManager,
                    this.promptManager
                );
                this.agentManager.registerAgent('game', gameAgent);
            }
            // Initialize AgentManager
            // In TelegramBot_Agents constructor or initialization
            this.agentManager.setTelegramBot(this);  // Important: Set the telegram bot reference
            this.agentManager.registerAgent('rag', this.ragAgent);
            this.agentManager.setConversationManager(this.conversationManager);
            this.conversationManager.setRAGAgent(this.ragAgent);  // Set RAGAgent after creation

            // Set memory in ConversationManager
            this.conversationManager.setMemory(this.memory);
            this.welcomeMessage = welcomeMessage;
            this.idleTimeout = idleTimeout;
            //this.memory = memoryManager;
            this.conversationManager.onBotStop = async () => {
                // Perform any necessary cleanup
                this.isInitialized = false;
                this.bot = null;
                // Any other cleanup operations...
            };
            console.log("Prompts initialized:");
            console.log("RAG System Prompt:", this.ragSystemPrompt);
            console.log("General System Prompt:", this.generalSystemPrompt);
            console.log("Human Message Template:", this.humanMessageTemplate);

            // Handle credential
            const credentialId = nodeData.credential;
            if (!credentialId) {
                throw new Error('Telegram API credential not found');
            }

            const credentialData = await getCredentialData(credentialId, options);
            if (!credentialData) {
                throw new Error(`Failed to fetch credential data for id: ${credentialId}`);
            }

            this.botToken = getCredentialParam('botToken', credentialData, nodeData);
            if (!this.botToken) {
                throw new Error('Bot token not found in credential data');
            }
            if (this.bot) {
                try {
                    await this.bot.stop('reinitializing Bot');
                    this.bot = null; // Add this line
                } catch (error) {
                    console.warn(`Error stopping existing bot: ${error.message}`);
                }
            }

            // Initialize Telegram bot
            if (!this.bot) {
                this.bot = new Telegraf<Context>(this.botToken, {
                    handlerTimeout: 400000 // 4 minutes in milliseconds
                });

                try {
                    const botInfo = await this.bot.telegram.getMe();
                    this.setupActionHandlers();
                    this.setupMessageHandlers(interactionType!);
                    this.botId = botInfo.id;
                    console.log(`[FlowID: ${this.flowId}] Bot initialized with ID: ${this.botId}`);
                } catch (error) {
                    console.error(`[FlowID: ${this.flowId}] Error getting bot info:`, error);
                    throw error;
                }

                if (!this.isRunning) {
                    console.log(`[FlowID: ${this.flowId}] Bot launch initiated`);
                    // Do not await bot.launch()
                    this.bot.launch()
                        .then(() => {
                            console.log(`[FlowID: ${this.flowId}] Bot has stopped.`);
                            this.isRunning = false;
                        })
                        .catch((error) => {
                            if (error.code === 409) {
                                console.warn(`[FlowID: ${this.flowId}] Bot is already running. Setting isRunning to true.`);
                                this.isRunning = true;
                            } else {
                                console.error(`[FlowID: ${this.flowId}] Failed to launch bot:`, error);
                                this.isRunning = false;
                            }
                        });
                    this.isRunning = true;
                    console.log(`[FlowID: ${this.flowId}] Bot launched successfully.`);
                } else {
                    console.log(`[FlowID: ${this.flowId}] Bot is already running. Skipping launch.`);
                }
            } else {
                console.log(`[FlowID: ${this.flowId}] Bot already initialized and running. Skipping bot initialization and launch.`);
            }

            // await this.checkRetrieverConfiguration();

            // Initialize CommandHandler
            if (this.bot && this.conversationManager) {
                console.log('Bot and ConversationManager initialized. Initializing CommandHandler...');
                this.commandHandler = new CommandHandler(
                    this.bot,
                    this.conversationManager,
                    this.memory,
                    this.promptManager,
                    this.agentManager,
                    this.menuManager,
                    this.flowId,
                    {
                        telegramBot: this
                    }
                );
                console.log('CommandHandler created. Registering commands...');
                await this.commandHandler.registerCommands();
                this.commandHandler.createCommandMenus();
                console.log('Commands registered successfully.');
            } else {
                throw new Error('Bot or ConversationManager is not initialized. Cannot create CommandHandler.');
            }


            // Set component references
            this.commandHandler.setConversationManager(this.conversationManager);
            this.commandHandler.setMemory(this.memory);
            this.commandHandler.setPromptManager(this.promptManager);
            this.commandHandler.setAgentManager(this.agentManager);
            this.commandHandler.setMenuManager(this.menuManager);

            this.isInitialized = true;
            options.telegramBotInstance = this;

            console.log('PromptManager state:', this.promptManager ? 'Initialized' : 'Not initialized');
            console.log('[performInitialization] TelegramBot_Agents initialization completed successfully');
        } catch (error) {
            console.error("Error in initialization:", error);
            this.isInitialized = false;
            throw error;
        }
    }
    // Add the postProcessDocuments method to the TelegramBot_Agents class, to do with MultiQueryTelegramBot node if not connected, May not be used here:

    private async postProcessDocuments(
        docs: Document<ExtendedMetadata>[],
        query: string,
        verbose: boolean
    ): Promise<Document<ExtendedMetadata>[]> {
        // Implement your post-processing logic here
        // This could involve using the LLM to extract relevant information, etc.
        // For now, we'll just return the documents as-is
        return docs;
    }


    private setupMessageHandlers(progressKey: string, interactionType?: InteractionType): void {
        if (!this.bot) {
            console.error('setupMessageHandlers: Bot is not initialized');
            return;
        }

        console.log('Setting up message handlers');

        // Add a debounce map to track message processing
        const processingDebounce = new Map<string, {
            timeout: NodeJS.Timeout;
            updates: Context<Update>[];
            timestamp: number;
        }>();

        this.bot.on('message', async (ctx: Context<Update>) => {
            console.log('Received message:', ctx.message);

            // Check if this is a text message
            if (!ctx.message || !('text' in ctx.message) || !ctx.message.text) {
                // For non-text messages, process normally
                const adapter = new ContextAdapter(ctx, this.promptManager);
                await this.handleMessage(adapter, this.conversationManager!, this.agentManager);
                return;
            }

            // Generate buffer key from chat and user IDs
            const chatId = ctx.chat?.id;
            const userId = ctx.from?.id;
            if (!chatId || !userId) {
                // If we can't identify the chat/user, process normally
                const adapter = new ContextAdapter(ctx, this.promptManager);
                await this.handleMessage(adapter, this.conversationManager!, this.agentManager);
                return;
            }

            const bufferKey = `${chatId}:${userId}`;

            // Handle commands immediately (don't buffer)
            if (ctx.message.text.startsWith('/')) {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                await this.handleMessage(adapter, this.conversationManager!, this.agentManager);
                return;
            }

            // Always add to buffer, then process with debounce
            let debounceInfo = processingDebounce.get(bufferKey);

            if (!debounceInfo) {
                // Create new debounce entry
                const timeout = setTimeout(async () => {
                    const info = processingDebounce.get(bufferKey);
                    if (info) {
                        console.log(`[setupMessageHandlers] Processing ${info.updates.length} updates after debounce for ${bufferKey}`);
                        processingDebounce.delete(bufferKey);

                        // Add all messages to the buffer
                        for (const update of info.updates) {
                            await this.bufferTelegramUpdate(bufferKey, update, false); // Don't process immediately
                        }

                        // Now process the full buffer
                        await this.processTelegramUpdates(bufferKey);
                    }
                }, 1000); // 1 second debounce - wait to see if more parts arrive

                debounceInfo = {
                    timeout,
                    updates: [ctx],
                    timestamp: Date.now()
                };

                processingDebounce.set(bufferKey, debounceInfo);
            } else {
                // Add to existing debounce entry
                clearTimeout(debounceInfo.timeout);
                debounceInfo.updates.push(ctx);

                // Reset the timeout
                debounceInfo.timeout = setTimeout(async () => {
                    const info = processingDebounce.get(bufferKey);
                    if (info) {
                        console.log(`[setupMessageHandlers] Processing ${info.updates.length} updates after debounce reset for ${bufferKey}`);
                        processingDebounce.delete(bufferKey);

                        // Add all messages to the buffer
                        for (const update of info.updates) {
                            await this.bufferTelegramUpdate(bufferKey, update, false); // Don't process immediately
                        }

                        // Now process the full buffer
                        await this.processTelegramUpdates(bufferKey);
                    }
                }, 1000); // 1 second debounce after each new message

                debounceInfo.timestamp = Date.now();
                processingDebounce.set(bufferKey, debounceInfo);
            }
        });

        // Other handlers remain the same
        this.bot.on('callback_query', (ctx: Context<Update>) => {
            console.log('Received unhandled callback query:', ctx.callbackQuery);
            const adapter = new ContextAdapter(ctx, this.promptManager);
            return this.handleCallbackQuery(adapter, interactionType!, progressKey);
        });

        console.log('Message handlers set up successfully');
    }

    /**
    * Buffers a Telegram update that might be part of a split message
    * @param processImmediately Whether to process immediately if buffer reaches threshold
    */
    private async bufferTelegramUpdate(
        bufferKey: string,
        ctx: Context<Update>,
        processImmediately: boolean = true
    ): Promise<void> {
        const existingBuffer = this.updateBuffer.get(bufferKey);
        const currentTime = Date.now();

        // Case 1: No existing buffer - start one
        if (!existingBuffer) {
            console.log(`[bufferTelegramUpdate] Starting buffer for ${bufferKey}`);

            // Schedule processing timeout only if we're processing immediately
            let timer: NodeJS.Timeout | null = null;
            if (processImmediately) {
                timer = setTimeout(() => {
                    this.processTelegramUpdates(bufferKey);
                }, this.MESSAGE_JOINING_WINDOW);
            }

            // Create new buffer
            this.updateBuffer.set(bufferKey, {
                updates: [ctx],
                lastUpdate: currentTime,
                processingTimer: timer
            });

            return;
        }

        // Case 2: Add to existing buffer
        existingBuffer.updates.push(ctx);
        existingBuffer.lastUpdate = currentTime;

        console.log(`[bufferTelegramUpdate] Added update ${existingBuffer.updates.length} to buffer for ${bufferKey}`);

        // Clear existing timer and set a new one if processing immediately
        if (existingBuffer.processingTimer) {
            clearTimeout(existingBuffer.processingTimer);
            existingBuffer.processingTimer = null;
        }

        if (processImmediately) {
            existingBuffer.processingTimer = setTimeout(() => {
                this.processTelegramUpdates(bufferKey);
            }, this.MESSAGE_JOINING_WINDOW);
        }

        // Safety check - if we've exceeded the update limit, process immediately if needed
        if (processImmediately && existingBuffer.updates.length >= this.MAX_BUFFERED_UPDATES) {
            console.log(`[bufferTelegramUpdate] Max updates reached for ${bufferKey}, processing now`);

            // Clear timer since we're processing now
            if (existingBuffer.processingTimer) {
                clearTimeout(existingBuffer.processingTimer);
                existingBuffer.processingTimer = null;
            }

            // Process immediately
            await this.processTelegramUpdates(bufferKey);
        }
    }

    /**
 * Processes buffered Telegram updates by joining their text
 */
    private async processTelegramUpdates(bufferKey: string): Promise<void> {
        const buffer = this.updateBuffer.get(bufferKey);
        if (!buffer || buffer.updates.length === 0) {
            console.warn(`[processTelegramUpdates] No buffer found for ${bufferKey}`);
            return;
        }

        console.log(`[processTelegramUpdates] Processing ${buffer.updates.length} updates for ${bufferKey}`);

        try {
            // Extract text from all updates - only keep ones with text
            const textParts = buffer.updates
                .filter(ctx => ctx.message && 'text' in ctx.message && ctx.message.text)
                .map(ctx => (ctx.message as any).text as string);

            if (textParts.length === 0) {
                console.warn(`[processTelegramUpdates] No text parts found in buffer for ${bufferKey}`);
                this.updateBuffer.delete(bufferKey);
                return;
            }

            // Only proceed with joining if we have multiple parts
            const shouldJoinParts = textParts.length > 1;

            // Join text parts if we have multiple parts
            const joinedText = shouldJoinParts
                ? this.joinMessageParts(textParts)
                : textParts[0];

            console.log(`[processTelegramUpdates] ${shouldJoinParts ? 'Joined' : 'Using'} ${textParts.length} parts (${joinedText.length} chars) for ${bufferKey}`);

            // Use the first update as the base
            const baseCtx = buffer.updates[0];

            // Special handling for telegram updates
            if (baseCtx.message && 'text' in baseCtx.message) {
                // Create a deep copy of the context to avoid modifying the original
                const modifiedCtx = JSON.parse(JSON.stringify(baseCtx));

                // Add joined text info
                modifiedCtx.__joinedText = joinedText;
                modifiedCtx.__originalText = baseCtx.message.text;
                modifiedCtx.__isJoinedMessage = true;
                modifiedCtx.__partCount = textParts.length;

                // Process with special handler
                await this.handleJoinedMessage(baseCtx, joinedText, textParts.length);
            } else {
                console.warn(`[processTelegramUpdates] Base update has no text message for ${bufferKey}`);

                // Process original as fallback
                const adapter = new ContextAdapter(baseCtx, this.promptManager);
                await this.handleMessage(adapter, this.conversationManager!, this.agentManager);
            }
        } catch (error) {
            console.error(`[processTelegramUpdates] Error processing updates for ${bufferKey}:`, error);

            // Fallback to first update
            if (buffer.updates.length > 0) {
                const firstUpdate = buffer.updates[0];
                const adapter = new ContextAdapter(firstUpdate, this.promptManager);
                await this.handleMessage(adapter, this.conversationManager!, this.agentManager);
            }
        } finally {
            // Clear buffer
            this.updateBuffer.delete(bufferKey);
        }
    }

    /**
 * Special handler for joined messages that preserves the original context
 */
    private async handleJoinedMessage(
        ctx: Context<Update>,
        joinedText: string,
        partCount: number
    ): Promise<void> {
        console.log(`[handleJoinedMessage] Processing joined message with ${joinedText.length} chars from ${partCount} parts`);

        try {
            // Create a deep copy of the original context to avoid modifying it
            // Instead of creating a new custom context, modify the original one's message text
            if (ctx.message && 'text' in ctx.message) {
                // Store the original text for debugging/reference
                const originalText = ctx.message.text;

                // Modify the message text directly in the original context
                ctx.message.text = joinedText;

                // Add metadata to the context for debugging and tracking
                (ctx as any).__joinedText = joinedText;
                (ctx as any).__originalText = originalText;
                (ctx as any).__isJoinedMessage = true;
                (ctx as any).__partCount = partCount;

                console.log(`[handleJoinedMessage] Modified original context with joined text (${joinedText.length} chars)`);

                // Use the original context with the modified text
                const adapter = new ContextAdapter(ctx, this.promptManager);

                // Process the joined message using the proper context
                await this.handleMessage(adapter, this.conversationManager!, this.agentManager);
            } else {
                throw new Error('Original message context does not contain text');
            }
        } catch (error) {
            console.error('[handleJoinedMessage] Error processing joined message:', error);

            // Try to send an error message
            try {
                await ctx.reply("I'm sorry, I had difficulty processing your multi-part message. Please try sending it differently.");
            } catch (replyError) {
                console.error('[handleJoinedMessage] Error sending error reply:', replyError);
            }
        }
    }

    /**
     * Intelligently joins message parts into a single coherent message
     */
    private joinMessageParts(parts: string[]): string {
        if (parts.length === 1) return parts[0];

        // Log the parts we're joining for debugging
        console.log(`[joinMessageParts] Joining ${parts.length} parts:`);
        parts.forEach((part, i) => {
            console.log(`Part ${i + 1} (${part.length} chars): ${part.substring(0, 50)}...`);
        });

        return parts.map((part, index) => {
            // Clean up continuation markers
            let cleaned = part.trim();

            // Remove trailing ellipsis/dash from all but the last part
            if (index < parts.length - 1) {
                cleaned = cleaned.replace(/(\.\.\.|…|---)$/, '');
            }

            // Remove leading ellipsis/dash from all but the first part
            if (index > 0) {
                cleaned = cleaned.replace(/^(\.\.\.|…|---)/, '');
            }

            return cleaned;
        }).join('\n\n'); // Join with double newlines for better formatting
    }


    async waitForInitialization(): Promise<void> {
        if (this.initializationPromise) {
            await this.initializationPromise;
        } else {
            throw new Error('Initialization is not in progress.');
        }
    }



    private parseBotInfoInput(input: string | undefined): BotInfo[] {
        if (!input) {
            console.warn('No bot information provided. Using an empty array.');
            return [];
        }

        console.log('Parsing bot info input:', input);

        const botInfo = input.split(',').map(botString => {
            const [id, firstName, username] = botString.trim().split(':');
            if (!id) {
                console.warn(`Invalid bot info format: ${botString}. Skipping this entry.`);
                return null;
            }
            const botInfoEntry = {
                id: parseInt(id),
                firstName: firstName || `Bot ${id}`,
                username: username || `bot_${id}`,
                is_bot: true,
                is_admin: false // Assuming bots are not admins by default
            };
            console.log('Parsed bot info:', botInfoEntry);
            return botInfoEntry;
        }).filter((bot): bot is BotInfo => bot !== null);

        console.log('Total parsed bot info entries:', botInfo.length);
        return botInfo;
    }
    public getBotIds(): number[] {
        if (!this.botInfo || !Array.isArray(this.botInfo)) {
            console.warn('Bot info is not properly initialized');
            return [];
        }
        return this.botInfo.map(bot => bot.id);
    }
    // Method to get bot IDs (for compatibility with existing code)
    // public getBotIds(): number[] {
    //     return this.botInfo.map(bot => bot.id);
    // }

    // New method to get all bot info
    public getAllBotInfo(): BotInfo[] {
        return this.botInfo;
    }

    private setupActionHandlers(): void {
        console.log('Entering setupActionHandlers method');
        if (!this.bot) {
            console.error('setupActionHandlers: Bot is not initialized');
            return;
        }

        this.bot.action(/confirm_(\d+)_(.+)/, (ctx) => {
            console.log('Confirm clear memory action triggered with data:', ctx.match);
            return this.handleConfirmClearMemory(ctx);
        });

        this.bot.action(/cancel_(\d+)_(.+)/, (ctx) => {
            console.log('Cancel clear memory action triggered with data:', ctx.match);
            return this.handleCancelClearMemory(ctx);
        });

        this.bot.action(/confirm_all_(\d+)/, (ctx) => {
            console.log('Confirm clear all memory action triggered with data:', ctx.match);
            return this.handleConfirmClearAllMemory(ctx);
        });

        this.bot.action(/cancel_all_(\d+)/, (ctx) => {
            console.log('Cancel clear all memory action triggered with data:', ctx.match);
            return this.handleCancelClearAllMemory(ctx);
        });

        console.log('Action handlers set up successfully');
    }


    public getGroupMembers(chatId: number): Map<number, GroupMemberInfo> | undefined {
        return this.groupMembers.get(chatId);
    }

    public async updateGroupMembers(ctx: Context): Promise<void> {
        console.log("Entering updateGroupMembers");
        if (!ctx.chat) {
            console.error('Chat context is undefined');
            return;
        }

        if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
            try {
                const chatId = ctx.chat.id;
                console.log(`Fetching members for chat ${chatId}`);

                // Fetch administrators
                const admins = await ctx.telegram.getChatAdministrators(chatId);
                console.log(`Fetched ${admins.length} administrators`);

                // Initialize member info map
                const memberInfo = new Map<number, GroupMemberInfo>();

                // Add admins to the member info
                admins.forEach((admin: ChatMember) => {
                    memberInfo.set(admin.user.id, {
                        is_bot: admin.user.is_bot,
                        is_admin: true,
                        username: admin.user.username,
                        first_name: admin.user.first_name
                    });
                });

                // Add known bots from BotInfo
                this.botInfo.forEach(bot => {
                    if (!memberInfo.has(bot.id)) {
                        memberInfo.set(bot.id, {
                            is_bot: true,
                            is_admin: false,
                            username: bot.username,
                            first_name: bot.firstName
                        });
                    }
                });

                this.groupMembers.set(chatId, memberInfo);
                if (this.conversationManager) {
                    this.conversationManager.setGroupMembers(chatId, memberInfo);
                    console.log(`Group members set in ConversationManager for chat ${chatId}`);
                } else {
                    console.error('ConversationManager is not initialized');
                }

                console.log(`Updated group members for chat ${chatId}`);
                await ctx.reply(`Group member list updated.`);

            } catch (error) {
                console.error('Error updating group members:', error);
                await ctx.reply('Failed to update group member list.');
            }
        } else {
            console.log("Not a group chat, skipping member update");
            await ctx.reply('This command can only be used in group chats.');
        }
    }
    private async handleConfirmClearMemory(ctx: Context) {
        console.log('Entering handleConfirmClearMemory');
        const adapter = new ContextAdapter(ctx, this.promptManager);
        const methodName = 'handleConfirmClearMemory';
        const context = adapter.getMessageContext();

        if (!this.conversationManager || !this.agentManager || !this.promptManager) {
            logError(methodName, 'Essential managers are not initialized', new Error('Essential managers are null'));
            return "I'm sorry, but I'm not ready to Delete messages yet 🧐.";
        }



        if (!ctx.match) {
            console.error(`${methodName}: No match found in context`);
            await adapter.answerCallbackQuery('An error occurred. Please try again.');
            return;
        }

        console.log(`${methodName}: Match data:`, ctx.match);
        const { userId, sessionId } = await this.conversationManager.getSessionInfo(adapter);
        //   const [, userId, sessionId] = ctx.match;

        if (!this.memory) {
            console.error(`${methodName}: Memory is not initialized`);
            await adapter.answerCallbackQuery('Bot memory is not initialized. Please try again later.');
            await adapter.editMessageText('An error occurred. Bot memory is not initialized.');
            return;
        }

        try {
            await this.memory.clearChatMessagesExtended(userId, sessionId);
            await adapter.answerCallbackQuery('Memory cleared successfully.');
            await adapter.editMessageText('Your chat memory has been cleared.');
            console.log(`${methodName}: Memory cleared successfully for user ${userId} in session ${sessionId}`);
        } catch (error) {
            console.error(`${methodName}: Error clearing memory for user ${userId}:`, error);
            await adapter.answerCallbackQuery('An error occurred while clearing memory.');
            await adapter.editMessageText('An error occurred while clearing memory. Please try again later.');
        }
    }

    private async handleCancelClearMemory(ctx: Context) {
        const adapter = new ContextAdapter(ctx, this.promptManager);
        await adapter.answerCallbackQuery('Memory clear cancelled.');
        await adapter.editMessageText('Memory clear cancelled. Your chat history remains intact.');
    }



    private async handleConfirmClearAllMemory(ctx: Context) {
        const adapter = new ContextAdapter(ctx, this.promptManager);
        const methodName = 'handleConfirmClearAllMemory';

        if (!ctx.match) {
            logError(methodName, 'No match found in context', new Error('Match is null'));
            await adapter.answerCallbackQuery('An error occurred. Please try again.');
            return;
        }

        const [, userId] = ctx.match;
        const adminId = parseInt(userId);

        if (!this.conversationManager || !this.memory) {
            logError(methodName, 'ConversationManager or Memory is not initialized', '');
            await adapter.answerCallbackQuery('Bot is not fully initialized. Please try again later.');
            await adapter.editMessageText('An error occurred. Bot is not fully initialized.');
            return;
        }

        try {
            logInfo(methodName, `Admin ${adminId} attempting to clear all memory`);

            const extendedMemory = this.memory as any;
            const client = extendedMemory.zepClient;

            if (!client?.memory) {
                console.error(`[${methodName}] No memory interface in zepClient`);
            } else {
                try {
                    console.log(`[${methodName}] Attempting to list sessions...`);
                    // Use the correct memory interface
                    const { sessions } = await client.memory.listSessions({
                        pageSize: 100,  // Adjust as needed
                        pageNumber: 1
                    });

                    console.log(`[${methodName}] Found ${sessions.length} sessions to clear`);

                    // Delete each session using the memory interface
                    for (const session of sessions) {
                        try {
                            await client.memory.delete(session.sessionId);
                            console.log(`[${methodName}] Deleted session: ${session.sessionId}`);
                        } catch (error) {
                            console.warn(`[${methodName}] Error deleting session ${session.sessionId}:`, error);
                        }
                    }
                } catch (error) {
                    console.error(`[${methodName}] Error listing sessions:`, error);
                }
            }

            // Clear current session as well
            await this.memory.clear();
            console.log(`[${methodName}] Cleared current session`);

            logInfo(methodName, `All memory cleared successfully by admin ${adminId}`);

            await adapter.answerCallbackQuery('All memory cleared successfully.');
            await adapter.editMessageText('All chat memories have been cleared.');

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            logError(methodName, `Error clearing all memory`, error as Error);

            await adapter.answerCallbackQuery('An error occurred while clearing memory.');
            await adapter.editMessageText(`An error occurred while clearing memory: ${errorMessage}`);
        }
    }
    private async handleCancelClearAllMemory(ctx: Context) {
        const adapter = new ContextAdapter(ctx, this.promptManager);
        const methodName = 'handleCancelClearAllMemory';

        try {
            await adapter.answerCallbackQuery('Clear all memory cancelled.');
            await adapter.editMessageText('Clear all memory cancelled. All chat histories remain intact.');
            logInfo(methodName, 'Clear all memory action cancelled');
        } catch (error) {
            logError(methodName, 'Error handling cancel clear all memory', error as Error);
            await adapter.answerCallbackQuery('An error occurred. Please try again.');
        }
    }

    private adaptMemory(externalMemory: any): IExtendedMemory {
        const methodName = 'adaptMemory';

        const getMemoryClient = async () => {
            try {
                // Check the type of memory we're dealing with
                const memoryType = externalMemory.getMemoryType?.();
                console.log(`[${methodName}] Memory type:`, memoryType);

                // Generic promise check
                const hasPromise = Object.keys(externalMemory).some(key =>
                    key.toLowerCase().includes('client') &&
                    externalMemory[key] instanceof Promise
                );

                if (hasPromise) {
                    console.log(`[${methodName}] Found async client initialization`);
                    for (const [key, value] of Object.entries(externalMemory)) {
                        if (value instanceof Promise) {
                            console.log(`[${methodName}] Waiting for client initialization:`, key);
                            const client = await value;
                            return client;
                        }
                    }
                }

                // If no promise found, return the memory object itself
                return externalMemory;
            } catch (error) {
                console.warn(`[${methodName}] Error getting memory client:`, error);
                return externalMemory;
            }
        };

        const initializeSession = async (userId: string, sessionId: string) => {
            const client = await getMemoryClient();

            try {
                if (client.memory?.addSession) {
                    await client.memory.addSession({
                        session: {  // Add this wrapper
                            session_id: sessionId,  // Use session_id instead of sessionId
                            user_id: userId     // Use user_id instead of userId
                        },
                        metadata: {
                            source: userId.startsWith('flowise_') ? 'flowise' : 'telegram',
                            created_at: new Date().toISOString()
                        }
                    });
                }
                console.log(`[${methodName}] Session initialized:`, sessionId);
                return true;
            } catch (error) {
                if (!error.message?.includes('already exists')) {
                    console.warn(`[${methodName}] Session initialization error:`, error);
                }
                return false;
            }
        };

        return {
            ...externalMemory,

            getChatMessagesExtended: async (userId: string, sessionId: string, returnBaseMessages?: boolean, prependMessages?: ExtendedIMessage[]) => {
                const client = await getMemoryClient();
                console.log(`[${methodName}] Getting messages with client type:`, client?.constructor?.name);
                try {
                    await initializeSession(userId, sessionId);
                    const messages = await client.getChatMessages(sessionId, returnBaseMessages, prependMessages);
                    console.log(`[${methodName}] Retrieved ${messages.length} messages using getChatMessages`);

                    // Clean the messages based on their type
                    const cleanedMessages = messages.map((msg: any) => {
                        if (msg instanceof BaseMessage) {
                            // For BaseMessage instances, create a new instance
                            const cleanedContent = this.cleanMessageContent(
                                typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                            );

                            if (msg.getType() === 'human') {
                                return new HumanMessage(cleanedContent, msg.additional_kwargs);
                            } else if (msg.getType() === 'ai') {
                                return new AIMessage(cleanedContent, msg.additional_kwargs);
                            } else {
                                return new SystemMessage(cleanedContent, msg.additional_kwargs);
                            }
                        } else {
                            // For other message types (like FlowiseIMessage)
                            const cleanedMessage = { ...msg };
                            if (typeof msg.message === 'string') {
                                cleanedMessage.message = this.cleanMessageContent(msg.message);
                            }
                            if (typeof msg.text === 'string') {
                                cleanedMessage.text = this.cleanMessageContent(msg.text);
                            }
                            return cleanedMessage;
                        }
                    });

                    if (returnBaseMessages) {
                        return cleanedMessages;
                    }

                    return this.convertToExtendedIMessages(cleanedMessages);
                } catch (error) {
                    console.error(`[${methodName}] Error getting messages:`, error);
                    return [];
                }
            },

            addChatMessagesExtended: async (msgArray: ExtendedIMessage[], userId: string, sessionId: string) => {
                if (typeof externalMemory.addChatMessages === 'function') {
                    // Validate messages before conversion
                    const validMessages = msgArray.filter(msg =>
                        msg && msg.message &&
                        (typeof msg.message === 'string' ? msg.message.trim() !== '' : true)
                    );

                    if (validMessages.length === 0) {
                        console.log('No valid messages to add to memory');
                        return;
                    }

                    // Add required memory structure while ensuring type compatibility
                    const formattedMessages: (BaseMessage | ExtendedIMessage)[] = validMessages.map(msg => ({
                        ...msg,
                        input: msg.input ?? undefined, // Ensure `input` aligns with the expected type
                        output: msg.output ?? undefined, // Ensure `output` aligns with the expected type
                        content: typeof msg.message === 'string' ? msg.message : undefined, // Ensure `content` is a string or undefined
                    }));

                    return externalMemory.addChatMessages(
                        this.convertToFlowiseIMessages(formattedMessages),
                        sessionId
                    );
                }
                throw new Error("addChatMessages not implemented");
            },



            clearChatMessagesExtended: async (userId: string, sessionId: string) => {
                if (typeof externalMemory.clearChatMessages === 'function') {
                    if (!this.memory) {
                        console.log`[${methodName}] Bot memory is not initialized. Please try again later.`;
                        return;
                    }
                    try {
                        const key = sessionId.startsWith('flowise_') ? sessionId : sessionId;
                        await this.memory.clear();
                        console.log(`[${methodName}] Cleared messages for key:`, key);
                    } catch (error) {
                        console.warn(`[${methodName}] Error clearing chat messages:`, error);
                    }
                }
            },

            // Rest of the methods remain the same...
            clearAllChatMessages: async () => {
                console.log(`[${methodName}] Attempting to clear all chat messages`);
                if (!this.memory) {
                    console.log`[${methodName}] Bot memory is not initialized. Please try again later.`;
                    return;
                }
                try {
                    if (typeof this.memory.clearAllChatMessages === 'function') {
                        await this.memory.clearAllChatMessages();
                        return;
                    }
                    if (typeof this.memory.clear === 'function') {
                        await this.memory.clear();
                        return;
                    }
                    if (typeof this.memory.clearChatMessages === 'function') {
                        await this.memory.clearChatMessages();
                        return;
                    }
                } catch (error) {
                    console.warn(`[${methodName}] Error clearing all chat messages:`, error);
                    // Don't throw - allow clear operations to fail gracefully
                }
            },


            // Keep existing FlowiseMemory properties and method bindings...
            getMemoryType: () => typeof externalMemory.getMemoryType === 'function'
                ? externalMemory.getMemoryType()
                : `Adapted${externalMemory.constructor.name || 'ExternalMemory'}`,
            returnMessages: externalMemory.returnMessages ?? true,
            inputKey: externalMemory.inputKey || 'input',
            outputKey: externalMemory.outputKey || 'output',
            humanPrefix: externalMemory.humanPrefix || 'Human',
            aiPrefix: externalMemory.aiPrefix || 'AI',
            memoryKey: externalMemory.memoryKey || 'chat_history',
            memoryKeys: externalMemory.memoryKeys || ['chat_history'],

            // Bind original methods
            getChatMessages: externalMemory.getChatMessages?.bind(externalMemory),
            addChatMessages: externalMemory.addChatMessages?.bind(externalMemory),
            clearChatMessages: externalMemory.clearChatMessages?.bind(externalMemory),
            saveContext: externalMemory.saveContext?.bind(externalMemory),
            loadMemoryVariables: externalMemory.loadMemoryVariables?.bind(externalMemory),
            clear: externalMemory.clear?.bind(externalMemory),
        };
    }
    private cleanMessageContent(content: string): string {
        if (!content) return '';

        try {
            // Clean up ZEP IDs and related text
            return content
                .replace(/user zep_[a-f0-9]+|zep_[a-f0-9]+/g, 'user')
                .replace(/(human who is a user|the user): User has the id of zep_[a-f0-9]+/g, '$1')
                .replace(/\s+/g, ' ')
                .trim();
        } catch (error) {
            console.error('Error cleaning message content:', error);
            return content;
        }
    }

    private convertToExtendedIMessages(messages: any[]): ExtendedIMessage[] {
        return messages.map(msg => {
            try {
                if (msg instanceof BaseMessage) {
                    const text = this.cleanMessageContent(
                        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                    );
                    return {
                        type: msg.getType() === 'human' ? 'userMessage' : 'apiMessage',
                        message: text,
                        text: text,
                        additional_kwargs: msg.additional_kwargs
                    };
                } else if ('message' in msg || 'text' in msg) {
                    // Handle FlowiseIMessage or similar
                    const text = this.cleanMessageContent(
                        (msg.message || msg.text || '').toString()
                    );
                    return {
                        type: msg.type || 'apiMessage',
                        message: text,
                        text: text,
                        additional_kwargs: msg.additional_kwargs
                    };
                }
                throw new Error(`Unsupported message type: ${typeof msg}`);
            } catch (error) {
                console.error('Error converting message:', error);
                return {
                    type: 'apiMessage',
                    message: 'Error processing message',
                    text: 'Error processing message'
                };
            }
        });
    }

    private convertToFlowiseIMessages(messages: (ExtendedIMessage | BaseMessage)[]): { text: string; type: MessageType; input?: { content: string }; output?: { content: string } }[] {
        const methodName = 'convertToFlowiseIMessages';
        console.log(`[${methodName}] Converting ${messages.length} messages`);

        return messages.map((msg, index) => {
            if (this.isExtendedIMessage(msg)) {
                const text = messageContentToString(msg.message || msg.text || '');
                const result: { text: string; type: MessageType; input?: { content: string }; output?: { content: string } } = {
                    type: msg.type,
                    text,
                    input: {
                        content: text
                    }
                };

                if (msg.type === 'apiMessage') {
                    result.output = {
                        content: text
                    };
                }

                console.log(`[${methodName}] Converted ExtendedIMessage ${index + 1}:`, {
                    type: result.type,
                    hasInput: !!result.input,
                    hasOutput: !!result.output
                });

                return result;
            } else if (this.isBaseMessage(msg)) {
                const text = messageContentToString(msg.content);
                const type = msg.getType() === 'human' ? 'userMessage' : 'apiMessage';
                const result: { text: string; type: MessageType; input?: { content: string }; output?: { content: string } } = {
                    type,
                    text,
                    input: {
                        content: text
                    }
                };

                if (type === 'apiMessage') {
                    result.output = {
                        content: text
                    };
                }

                console.log(`[${methodName}] Converted BaseMessage ${index + 1}:`, {
                    originalType: msg.getType(),
                    convertedType: type,
                    hasInput: !!result.input,
                    hasOutput: !!result.output
                });

                return result;
            }

            console.warn(`[${methodName}] Unknown message type for message ${index + 1}:`, msg);
            throw new Error("Unsupported message type");
        });
    }
    private isExtendedIMessage(msg: any): msg is ExtendedIMessage {
        return msg &&
            'type' in msg &&
            ('message' in msg || 'text' in msg) &&
            (msg.message !== null && msg.message !== undefined ||
                msg.text !== null && msg.text !== undefined);
    }

    private isBaseMessage(msg: any): msg is BaseMessage {
        return msg instanceof BaseMessage &&
            msg.content !== null &&
            msg.content !== undefined;
    }

    public convertToBaseMessages(messages: ExtendedIMessage[]): BaseMessage[] {
        console.log(`[convertToBaseMessages] Starting conversion of ${messages.length} messages to BaseMessages`);

        const baseMessages = messages.filter(msg => {
            const content = messageContentToString(msg.text || msg.message);
            return content !== null && content !== undefined && content.trim() !== '';
        }).map((msg, index) => {
            let baseMsg: BaseMessage;
            const content = messageContentToString(msg.text || msg.message);

            switch (msg.type) {
                case 'userMessage':
                    baseMsg = new HumanMessage(content);
                    break;
                case 'apiMessage':
                    baseMsg = new AIMessage(content);
                    break;
                default:
                    console.warn(`[convertToBaseMessages] Unknown message type at index ${index}, defaulting to SystemMessage`);
                    baseMsg = new SystemMessage(content);
            }

            // Add input/output structure to additional_kwargs
            baseMsg.additional_kwargs = {
                ...msg.additional_kwargs,
                input: {
                    content
                },
                output: msg.type === 'apiMessage' ? {
                    content
                } : undefined
            };

            console.log(`[convertToBaseMessages] Converted message ${index + 1}:`, JSON.stringify({
                type: baseMsg.getType(),
                content: this.conversationManager!.getContentPreview(baseMsg.content),
                additional_kwargs: baseMsg.additional_kwargs
            }, null, 2));

            return baseMsg;
        });

        console.log(`[convertToBaseMessages] Completed conversion, resulting in ${baseMessages.length} BaseMessages`);
        return baseMessages;
    }
    public togglePersona(enable: boolean): void {
        if (this.conversationManager) {
            this.conversationManager.togglePersona(enable);
        } else {
            console.warn('ConversationManager not initialized. Cannot toggle persona.');
        }
    }

    public async stop(signal?: string): Promise<void> {
        console.log(`[FlowID: ${this.flowId}] Stopping TelegramBot_Agents${signal ? ` due to ${signal}` : ''}...`);

        try {
            // Clear update process
            if (this.updateProcess) {
                clearInterval(this.updateProcess);
                this.updateProcess = null;
                console.log(`[FlowID: ${this.flowId}] Update process cleared.`);
            }

            // Stop the bot
            if (this.bot && this.isRunning) {
                console.log(`[FlowID: ${this.flowId}] Stopping bot${signal ? ` due to ${signal}` : ''}...`);
                try {
                    await this.bot.stop(signal);
                    console.log(`[FlowID: ${this.flowId}] Bot stopped successfully.`);
                } catch (error) {
                    console.error(`[FlowID: ${this.flowId}] Error stopping bot:`, error);
                }
            }

            // Clean up managers
            await this.cleanupManagers();

            // Reset state
            this.isInitialized = false;
            this.isRunning = false;
            this.bot = null;
            this.memory = null;
            this.botInfo = [];

            // Remove this flow's data from chat-to-flow mapping
            this.removeChatFlowMapping();

            console.log(`[FlowID: ${this.flowId}] TelegramBot_Agents stopped successfully.`);
        } catch (error) {
            console.error(`[FlowID: ${this.flowId}] Error during stop process:`, error);
        }
    }

    private async cleanupManagers(): Promise<void> {
        console.log(`[FlowID: ${this.flowId}] Cleaning up managers...`);

        if (this.conversationManager) {
            await this.conversationManager.cleanup();
            (this.conversationManager as any) = null;
        }

        if (this.promptManager) {
            this.promptManager.cleanup();
            (this.promptManager as any) = null;
        }

        if (this.agentManager) {
            await this.agentManager.cleanup();
            (this.agentManager as any) = null;
        }

        if (this.menuManager) {
            this.menuManager.cleanup();
            (this.menuManager as any) = null;
        }

        if (this.commandHandler) {
            await this.commandHandler.cleanup();
            this.commandHandler = new CommandHandler(
                null as any, // bot
                null as any, // conversationManager
                null as any, // memory
                null as any, // promptManager
                null as any, // agentManager
                null as any, // menuManager
                null as any, // flowId
                { telegramBot: this }
            );
        }

        if (this.toolManager) {
            await this.toolManager.cleanup();
            (this.toolManager as any) = null;
        }

        console.log(`[FlowID: ${this.flowId}] Managers cleaned up successfully.`);
    }

    private removeChatFlowMapping(): void {
        for (const [chatId, flowId] of this.chatFlowMap.entries()) {
            if (flowId === this.flowId) {
                this.chatFlowMap.delete(chatId);
                console.log(`[FlowID: ${this.flowId}] Removed mapping for chatId: ${chatId}`);
            }
        }
    }

    private async processAIMessage(adapter: ContextAdapter, input: string): Promise<void> {
        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.conversationManager!.getSessionInfo(context);
        console.log(`Processing AI message for user ${userId} in session ${sessionId}`);
        // Implement AI message processing logic here
        // This could involve updating the conversation state or performing specific actions

        // For example:
        // await this.conversationManager.updateAIMessage(userId, sessionId, message);
        // Or any other specific actions you want to perform for AI messages
    }

    public async handleProcessingError(adapter: ContextAdapter, error: unknown): Promise<void> {
        const methodName = 'handleProcessingError';
        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.conversationManager!.getSessionInfo(context);

        logError(
            methodName,
            `Error processing message`,
            error,
            { userId, sessionId, messageId: context.messageId }
        );

        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        await adapter.reply(`I'm sorry, but I encountered an error while processing your message. Please try again later. If the problem persists, contact support.`);
    }

    private cleanMessage(context: MessageContext): string {
        // Safely check if chat exists and is private
        const isPrivateChat = context.raw?.chat?.type === 'private';

        // If no input, return empty string
        if (!context.input) return '';

        return isPrivateChat ?
            context.input.trim() :
            context.input.replace(new RegExp(`@${this.bot?.botInfo?.username}\\b`, 'i'), '').trim();
    }

    public async updateProgress(adapter: ContextAdapter, progressKey: string, stage: string): Promise<boolean> {
        console.log(`[TelegramBot_Agents:${this.flowId}] Called updateProgress with key: ${progressKey}, stage: ${stage}`);

        if (!adapter.isTelegramMessage()) {
            console.log(`[TelegramBot_Agents:${this.flowId}] Skipping update for non-Telegram message.`);
            return false;
        }

        return await adapter.updateProgress(this.flowId, progressKey, stage);
    }

    private splitMessage(text: string, maxLength: number): string[] {
        const chunks: string[] = [];
        let remainingText = text;

        while (remainingText.length > 0) {
            if (remainingText.length <= maxLength) {
                chunks.push(remainingText);
                break;
            }

            let chunk = remainingText.substring(0, maxLength);
            let splitIndex = chunk.lastIndexOf('\n');
            if (splitIndex === -1) splitIndex = chunk.lastIndexOf(' ');
            if (splitIndex === -1) splitIndex = maxLength;

            chunks.push(remainingText.substring(0, splitIndex));
            remainingText = remainingText.substring(splitIndex).trim();
        }

        return chunks;
    }

    private async handleCallbackQuery(adapter: ContextAdapter, interactionType: InteractionType, progressKey: string): Promise<void> {
        const methodName = 'handleCallbackQuery';
        const context = adapter.getMessageContext();
        if (!context.callbackQuery || !('data' in context.callbackQuery) || !context.callbackQuery.data) {
            console.error('Received callback query without data');
            return;
        }

        const data = context.callbackQuery.data.trim().toLowerCase();
        console.log('Received callback query data:', data);

        if (data.startsWith('prev_question:') || data.startsWith('next_question:') || data.startsWith('select_question:')) {
            const [action, setId] = data.split(':');
            const key = this.getChatKey(context);
            const questionSets = this.userQuestionSets.get(key);
            const questionData = questionSets?.get(setId);

            if (!questionData) {
                await adapter.safeAnswerCallbackQuery("This question set is no longer available.");
                return;
            }

            if (Date.now() > questionData.expirationTime) {
                await adapter.safeAnswerCallbackQuery("This question set has expired. Please generate new questions.");
                await this.cleanupQuestionSet(key, setId);
                return;
            }

            const now = Date.now();
            if (now - questionData.lastActionTime < 500) { // 500ms cooldown
                await adapter.safeAnswerCallbackQuery("Please wait a moment before your next action.");
                return;
            }
            questionData.lastActionTime = now;

            try {
                await adapter.safeAnswerCallbackQuery("💬");

                switch (action) {
                    case 'prev_question':
                        questionData.currentPage = (questionData.currentPage - 1 + questionData.questions.length) % questionData.questions.length;
                        await this.sendPaginatedQuestion(adapter, questionData, false);
                        break;
                    case 'next_question':
                        questionData.currentPage = (questionData.currentPage + 1) % questionData.questions.length;
                        await this.sendPaginatedQuestion(adapter, questionData, false);
                        break;
                    case 'select_question':
                        const selectedQuestion = questionData.questions[questionData.currentPage];
                        console.log(`Chat ${key} selected question: ${selectedQuestion}`);
                        await this.handleFollowUpQuestion(adapter, selectedQuestion);
                        break;
                }
            } catch (error) {
                console.error('Error handling question pagination:', error);
                if (error.description && error.description.includes('message to edit not found')) {
                    await adapter.safeAnswerCallbackQuery("This message is no longer available. Please generate new questions.");
                    await this.cleanupQuestionSet(key, setId);
                } else {
                    await adapter.safeAnswerCallbackQuery("An error occurred. Please try again.");
                }
            }
        } else if (data.startsWith('prev_citation:') || data.startsWith('next_citation:') || data.startsWith('close_citations:')) {
            const [action, setId] = data.split(':');
            const key = this.getCitationKey(context);
            const citationSets = this.userCitationSets.get(key);
            const citationData = citationSets?.get(setId);

            if (!citationData) {
                await adapter.safeAnswerCallbackQuery("This citation set is no longer available.");
                return;
            }

            if (Date.now() > citationData.expirationTime) {
                await adapter.safeAnswerCallbackQuery("This citation set has expired.");
                await this.cleanupCitationSet(key, setId);
                return;
            }

            const now = Date.now();
            if (now - citationData.lastActionTime < 500) { // 500ms cooldown
                await adapter.safeAnswerCallbackQuery("Please wait a moment before your next action.");
                return;
            }
            citationData.lastActionTime = now;

            try {
                await adapter.safeAnswerCallbackQuery("💬");

                switch (action) {
                    case 'prev_citation':
                        citationData.currentPage = (citationData.currentPage - 1 + citationData.citations.length) % citationData.citations.length;
                        await this.sendPaginatedCitation(adapter, citationData, false);
                        break;
                    case 'next_citation':
                        citationData.currentPage = (citationData.currentPage + 1) % citationData.citations.length;
                        await this.sendPaginatedCitation(adapter, citationData, false);
                        break;
                    case 'close_citations':
                        await this.cleanupCitationSet(key, setId);
                        await adapter.safeAnswerCallbackQuery("Citations closed.");
                        break;
                }
            } catch (error) {
                console.error('Error handling citation pagination:', error);
                if (error.description && error.description.includes('message to edit not found')) {
                    await adapter.safeAnswerCallbackQuery("This message is no longer available.");
                    await this.cleanupCitationSet(key, setId);
                } else {
                    await adapter.safeAnswerCallbackQuery("An error occurred. Please try again.");
                }
            }
        } else if (data.startsWith('fq:')) {
            await this.handleFollowUpQuestion(adapter, data.slice(3));
        } else if (data.startsWith('select_')) {
            const selectedBotId = parseInt(data.split('_')[1]);
            const botInfo = this.getAllBotInfo();
            const currentBotId = this.getBotIds()[0]; // Assuming the first ID is the current bot
            const selectedBot = botInfo.find(bot => bot.id === selectedBotId);

            if (selectedBot) {
                if (selectedBot.id === currentBotId) {
                    // This is the current bot, execute the start command
                    await this.commandHandler.executeCommandByName(adapter, 'start');
                } else {
                    // This is another bot, provide instructions to start it
                    const startCommand = `/start@${selectedBot.username}`;
                    await adapter.answerCallbackQuery(`To start ${selectedBot.firstName}, please use: ${startCommand}`);
                    await adapter.reply(`To activate ${selectedBot.firstName}, please click or tap this command: ${startCommand}`);
                }
            } else {
                await adapter.answerCallbackQuery("Sorry, I couldn't find the selected bot.");
            }
        } else if (data === 'help_command') {
            await this.commandHandler.executeCommandByName(adapter, 'help');
        } else if (data.startsWith('show_commands:')) {
            const [, botIdStr] = data.split(':');
            const callbackBotId = parseInt(botIdStr, 10);
            const thisBotId = this.bot?.botInfo?.id;

            if (thisBotId && callbackBotId === thisBotId) {
                await this.commandHandler.showCommandMenu(adapter, callbackBotId);
            } else {
                // This callback query is not for this bot, so we'll just acknowledge it
                await adapter.answerCallbackQuery('');
            }
        } else if (data.startsWith('execute_command:')) {
            const [, botId, commandName] = data.split(':');
            console.log(`Executing command: ${commandName}, for bot ID: ${botId}`);
            const thisBotId = this.bot?.botInfo?.id;
            if (thisBotId && parseInt(botId) === thisBotId) {
                await this.commandHandler.executeCommandByName(adapter, commandName);
            } else {
                console.warn(`Command mismatch. Expected Bot ID: ${thisBotId}, Received: ${botId}`);
                await adapter.answerCallbackQuery("This command is for a different bot.");
            }
        } else if (data.startsWith('change_page:')) {
            const [, botId, page] = data.split(':');
            await this.commandHandler.showCommandMenu(adapter, parseInt(botId), parseInt(page));
        } else if (data.startsWith('follow_up:')) {
            const question = data.split('follow_up:')[1];
            await adapter.answerCallbackQuery('');
            if (!this.conversationManager) {
                return;
            }
            if (context.callbackQuery.message && 'text' in context.callbackQuery.message) {
                const userId = context.userId.toString() || 'unknown';
                const { sessionId } = await this.conversationManager.getSessionInfo(adapter);
                const chatHistory = await this.getChatHistory(adapter);

                if (this.conversationManager) {
                    // We'll pass the question to handleMessage and let it handle the processing
                    await this.commandHandler.handleMessage(adapter, question);
                } else {
                    await adapter.reply("I'm sorry, but I'm not able to process follow-up questions at the moment.");
                }
            }
        } else if (data === 'remove_menu') {
            try {
                const deleted = await adapter.deleteMessage();
                if (deleted) {
                    console.log(`Menu removed successfully`);
                    await adapter.answerCallbackQuery('Menu removed successfully');
                } else {
                    console.error('Unable to remove menu');
                    await adapter.answerCallbackQuery('Unable to remove menu');
                }
            } catch (error) {
                console.error('Error removing menu:', error);
                await adapter.answerCallbackQuery('Error removing menu');
            }
        } else if (data.startsWith('millionaire_')) {
            const command = data.split('millionaire_')[1];
            if (this.commandHandler) {
                try {
                    const { userId, sessionId } = await this.conversationManager!.getSessionInfo(adapter);
                    console.warn(methodName, `Processing Command: ${command}, from source: ${context.source}`, { userId, sessionId });

                    const chatId = context.chatId;
                    const agentManager = this.getAgentManager();
                    if (!agentManager) {
                        throw new Error('AgentManager not available');
                    }

                    const gameAgent = agentManager.getAgent('game') as GameAgent;
                    if (!gameAgent) {
                        throw new Error('Game agent not available');
                    }

                    if (!chatId) {
                        throw new Error('Chat ID not available');
                    }

                    // Special case for 'new' command - allow anyone to start a new game
                    if (command === 'new') {
                        console.log(methodName, `Allowing new game creation for user ${userId}`);
                    }
                    // For all other commands, verify session ownership
                    else if (!gameAgent['isSessionOwner'](userId.toString(), chatId)) {
                        await adapter.answerCallbackQuery(
                            "Only the player who started the game can interact with it");
                        return;
                    }

                    if (progressKey) {
                        console.log(methodName, `Attempting to update progress for millionaire callback`);
                        const updated = await this.updateProgress(adapter, progressKey, "💰");
                        console.log(methodName, `Progress update result: ${updated}`);
                    }

                    // Route to CommandHandler's handleMillionaireCommand
                    await this.commandHandler.handleMillionaireCommand(
                        adapter,
                        command,
                        context.userId.toString()
                    );

                    return;
                } catch (error) {
                    // Error handling remains the same
                    console.error('Error handling millionaire callback:', error);
                    let errorMessage = "An error occurred processing your game action.";
                    if (error instanceof Error) {
                        if (error.message.includes('session')) {
                            errorMessage = error.message;
                        }
                    }
                    await adapter.answerCallbackQuery(errorMessage);
                }
            } else {
                console.error('CommandHandler not available for millionaire callback');
                await adapter.answerCallbackQuery(
                    "Game system is currently unavailable.",

                );
            }

        }
        else if (data.startsWith('pattern_')) {
            const methodName = 'handleCallbackQuery';

            // Parse the command using a more reliable approach
            const match = data.match(/^pattern_([^:]+)(?::(.+))?$/);
            if (!match) {
                console.warn(`[${methodName}] Invalid pattern command format:`, data);
                await adapter.answerCallbackQuery('Invalid pattern command');
                return;
            }

            const action = match[1]; // e.g., 'use', 'more', 'category', etc.
            const parameter = match[2]; // e.g., the pattern name, category, etc.

            console.log(`[${methodName}] Pattern action:`, action, 'parameter:', parameter);

            await this.commandHandler?.handlePatternAction(adapter, action, parameter);
            return;
        }

        else if (data.startsWith('thinking_')) {
            await this.commandHandler.handleThinkingCallback(adapter, data);
            return;
        } else {
            console.warn('Received unknown callback query:', data);
            await adapter.answerCallbackQuery("I don't know how to handle this action.");
        }
    }
    private formatCategoryName(category: string): string {
        return category.charAt(0).toUpperCase() + category.slice(1);
    }

    async handleMessage(
        adapter: ContextAdapter,
        conversationManager: ConversationManager,
        agentManager: AgentManager,
        interactionType?: InteractionType,
    ): Promise<string | FormattedResponse> { // Ensure return type is string
        const methodName = 'handleMessage';

        //console.log(methodName, ": Entering handleMessage");
        console.log('handleMessage: PromptManager state:', this.promptManager ? 'Initialized' : 'Not initialized');
        const context = adapter.getMessageContext();
        console.log(`[${methodName}] Entering handleMessage with payload:`, {
            context: {
                input: adapter.context,
                userId: adapter.getMessageContext().userId,
                chatId: adapter.getMessageContext().chatId,
                source: adapter.getMessageContext().source,
                auth: adapter.getMessageContext().raw?.auth,
                messageType: adapter.getMessageContext().raw?.message?.type,
                chatType: adapter.getMessageContext().raw?.chat?.type
            },
            hasConversationManager: !!conversationManager,
            hasAgentManager: !!agentManager,
            promptManagerState: this.promptManager ? 'Initialized' : 'Not initialized'
        });


        if (!context.raw.message || !context.raw.chat) {
            console.error('Invalid message or chat context');
            return "Error: Invalid message or chat context";
        }

        const message = context.raw.message;
        const chatId = context.chatId;

        // Get the botKey (chatflowId) from flowIdMap
        const flowIdEntry = Array.from(flowIdMap.entries())
            .find(([_, fId]) => fId === this.flowId);
        const botKey = flowIdEntry ? flowIdEntry[0] : undefined;

        // Log chatflowId resolution
        console.log(`[${methodName}] ChatflowId Resolution:`, {
            botKey,
            flowId: this.flowId,
            raw: {
                flowwise_chatflow_id: context.raw?.flowwise_chatflow_id,
                metadata_chatflowId: context.raw?.metadata?.chatflowId,
                options_chatflowid: (context.raw?.options as ICommonObject)?.chatflowid
            }
        });

        // Use botKey as chatflowId
        const chatflowId = botKey || this.flowId; // fallback to flowId if botKey not available

        // Use the already normalized userId from executeRun if available
        let userId: string;
        let numericUserId: number;

        if (context.source === 'flowise') {
            // For Flowise, use chatflowId-based ID from botKey
            userId = `flowise_${chatflowId}`;
            numericUserId = parseInt(context.userId.toString(), 10);
        } else {
            // For Telegram, get the normalized ID that was set in executeRun
            const normalizedId = context.userId.toString();
            if (normalizedId.startsWith('telegram_')) {
                userId = normalizedId;
                numericUserId = parseInt(normalizedId.replace('telegram_', ''), 10);
            } else if (normalizedId.match(/^[0-9]+$/)) {
                userId = `telegram_${normalizedId}`;
                numericUserId = parseInt(normalizedId, 10);
            } else {
                userId = normalizedId;
                numericUserId = parseInt(normalizedId.replace(/\D/g, ''), 10);
            }
        }

        // Early source check for non-Telegram messages
        if (context.source === 'flowise' || context.source === 'webapp') {
            const response = await handleNonTelegramMessage(adapter, conversationManager, agentManager, this, interactionType!);
            if (Math.random() < 0.01) {
                await this.triggerCleanup();
            }

            if (typeof response === 'string') {
                logInfo(methodName, `String response received from handleNonTelegramMessage:`, {
                    source: context.source,
                    responsePreview: response.substring(0, 100)
                });
                return response;
            }

            logInfo(methodName, `Formatted response received from handleNonTelegramMessage:`, {
                source: context.source,
                responseType: 'FormattedResponse',
                hasText: !!response.text,
                hasContent: !!response.content,
                hasTokenStats: !!response.metadata?.tokenStats,
                responsePreview: response.text?.substring(0, 100)
            });

            if (context.source === 'webapp' && response.text && response.content) {
                return {
                    ...response,
                    text: response.text,
                    content: response.content
                } as FormattedResponse;
            }

            return response;
        }

        // For Telegram messages, proceed with validation
        if (!context.raw.message || !context.raw.chat) {
            console.error('Invalid message or chat context');
            return "Error: Invalid message or chat context";
        }

        // Bot checks only for Telegram messages
        if (!this.bot) {
            console.log('No Bots Here!.');
            return "Error: Bot not on the job!";
        }



        logInfo(methodName, `Processing message from source: ${context.source}`, {
            userId,
            chatId: context.chatId,
            chatflowId: chatflowId || 'not available'
        });

        const flowId = this.flowId;
        console.log(`[FlowID: ${flowId}] Received message: ${adapter.context}`);

        //const senderId = context.userId;
        const senderUsername = context.username;
        const isReply = 'reply_to_message' in message && !!message.reply_to_message;

        // Check if this chat already has a flowId


        if (!userId) {
            console.error('Sender ID is undefined');
            return "Error: Sender ID is undefined";
        }




        const botUsername = this.bot.botInfo?.username;
        if (!botUsername) {
            console.error('Bot username is undefined');
            return "Error: Bot username is undefined";
        }

        // Ignore messages from other bots
        if (message.from?.is_bot && message.from.username !== botUsername) {
            return "Not our bot. Ignore";
        }

        console.log("Received message:", JSON.stringify(message, null, 2));

        if (userId) {
            this.updateUserActivity(numericUserId);
            if (this.isUserSessionExpired(numericUserId)) {
                await this.handleSessionExpired(adapter);
                return "Times up buddy";
            }
        }

        const chatType = context.raw.chat.type;
        const isPrivateChat = chatType === 'private';
        const isGroup = chatType === 'group' || chatType === 'supergroup';

        let text: string = context.input;
        let isCaption = false;

        if ('caption' in message && message.caption) {
            text = message.caption;
            isCaption = true;
        }

        // Handle question selection

        if (this.awaitingQuestionSelection.get(numericUserId)) {
            const selectedNumber = parseInt(text);
            const userData = this.userQuestions.get(numericUserId);
            if (userData && !isNaN(selectedNumber) && selectedNumber > 0 && selectedNumber <= userData.questions.length) {
                const selectedQuestion = userData.questions[selectedNumber - 1];
                // Process the selected question
                await this.prepareAndProcessUserInput(adapter, selectedQuestion);
                // Clear the selection flag and stored questions
                this.awaitingQuestionSelection.delete(numericUserId);
                this.userQuestions.delete(numericUserId);
            } else {
                await adapter.reply('Invalid selection. Please try again or type a new message to cancel question selection.');
                return "Invalid selection. Please try again or type a new message to cancel question selection.";
            }
        }

        // Handle commands and special cases (Start, Show Commands, Help)
        if (await this.handleSpecialCases(adapter, text, isGroup, botUsername)) {
            return "";
        }

        const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
        const isRagModeEnabled = ragAgent.isRAGModeEnabled(userId.toString());

        let replyToMessage: { message_id: number; text: string } | undefined;
        let isDirectedAtThisBot = false;

        const botId = this.bot.botInfo?.id;

        if (!botUsername || !botId) {
            console.error('Bot username or ID is undefined');
            return "Bot username or ID is undefined";
        }

        // Check if the message is a reply to this bot's message
        if (isReply && message.reply_to_message?.from?.id === botId) {
            replyToMessage = {
                message_id: message.reply_to_message.message_id,
                text: 'text' in message.reply_to_message ? message.reply_to_message.text || '' : ''
            };
            isDirectedAtThisBot = true;
        }

        // Determine if we should process this message
        let shouldProcess = isPrivateChat || text.includes(`@${botUsername}`) || isDirectedAtThisBot || (isGroup && isRagModeEnabled);

        if (!shouldProcess && isGroup) {
            // Check if the message mentions this bot
            const botMentionRegex = new RegExp(`@${botUsername}\\b`, 'i');
            if (botMentionRegex.test(text)) {
                isDirectedAtThisBot = true;
                // Remove the bot mention from the text
                text = text.replace(botMentionRegex, '').trim();
            }
        }

        if (shouldProcess) {
            let processedText = isRagModeEnabled ? `[RAG] ${text}` : text;

            console.log(`Processing message from sender ${numericUserId} (username: ${context.username}) in chat ${chatId}`);
            console.log(`Sender info: ${JSON.stringify(message.from, null, 2)}`);
            console.log(`Processed message: "${processedText}"`);

            if (!this.conversationManager) {
                logError(methodName, 'ConversationManager is not initialized', new Error('ConversationManager is null'));
                await adapter.reply("I'm sorry, but I'm not ready to process messages yet.");
                return "I'm sorry, but I'm not ready to process messages yet.";
            }

            // Check if this is a response to the RAG mode continuation prompt
            if (isRagModeEnabled && (text.toLowerCase() === 'yes' || text.toLowerCase() === 'no')) {
                await this.handleRagModeResponse(adapter, text);
                return '';
            }

            const { userId, sessionId } = await this.conversationManager.getSessionInfo(adapter);
            logInfo(methodName, `Processing message from source: ${context.source}`, { userId, sessionId });


            const messageId = message.message_id;
            const progressKey = `${chatId}:${messageId}`;

            try {

                const initialConfirmation = this.getRandomConfirmationMessage();
                this.progressMessages.set(progressKey, initialConfirmation);

                let sentConfirmation;
                try {
                    sentConfirmation = await adapter.reply(initialConfirmation);
                    const newProgressKey = `${chatId}:${sentConfirmation.message_id}`;
                    this.sentConfirmations.set(newProgressKey, sentConfirmation.message_id);
                    this.progressMessages.set(newProgressKey, initialConfirmation);
                    console.log(`[${methodName}] Set initial progress for key: ${newProgressKey}`);
                } catch (error) {
                    console.error('Error sending confirmation message:', error);
                }

                if (sentConfirmation) {
                    await this.updateProgress(adapter, `${chatId}:${sentConfirmation.message_id}`, "✉️ Preparing to process your message...");
                }

                let cleanedMessage = this.cleanMessage(context);
                console.log(`Cleaned message: "${cleanedMessage}"`);

                const isPrivateChat = context.raw.chat.type === 'private';
                const isGroup = !isPrivateChat;
                let isAI = isGroup ?
                    (await this.isBotInGroup(chatId, userId) && numericUserId !== this.botId) :
                    this.isAIUser(message.from);

                try {
                    if (!context.raw.message) {
                        throw new Error('Invalid message format');
                    }

                    // Helper function to determine chat type
                    const getChatType = (type?: string): Chat['type'] => {
                        switch (type) {
                            case 'private':
                            case 'group':
                            case 'supergroup':
                                return type;
                            default:
                                return 'private';  // default to private if unknown
                        }
                    };

                    // Create a properly typed message object
                    const telegramMessage: Message.TextMessage = {
                        message_id: context.raw.message.message_id,
                        date: Math.floor(Date.now() / 1000),
                        chat: {
                            id: this.parseId(context.chatId),
                            type: getChatType(context.raw.chat?.type),
                            ...(context.raw.chat?.title && { title: context.raw.chat.title }),
                            ...(context.raw.chat?.username && { username: context.raw.chat.username }),
                            ...(context.raw.chat?.first_name && { first_name: context.raw.chat.first_name }),
                            ...(context.raw.chat?.last_name && { last_name: context.raw.chat.last_name })
                        } as Chat,  // Use Chat type from Telegraf
                        from: {
                            id: this.parseId(context.userId),
                            is_bot: false,
                            first_name: context.first_name || 'Unknown',
                            ...(context.username && { username: context.username })
                        },
                        text: context.input  // Required for TextMessage
                    };

                    await this.processMessage(
                        adapter,
                        telegramMessage,
                        isAI,
                        context.isReply,
                        interactionType,
                        context.replyToMessage,
                        sentConfirmation ? `${context.chatId}:${sentConfirmation.message_id}` : undefined
                    );
                    if (sentConfirmation) {
                        await this.updateProgress(adapter, `${chatId}:${sentConfirmation.message_id}`, "✔️Finalizing the response...💥");
                    }

                    console.log(`[${methodName}] AI response generated`);


                } catch (error) {
                    console.error(`[${methodName}] Error:`, error);
                    await this.handleProcessingError(adapter, error);
                } finally {
                    if (sentConfirmation) {
                        try {
                            // Wait a short time before deleting the confirmation message
                            setTimeout(async () => {
                                await adapter.deleteMessage(sentConfirmation.message_id);
                                this.progressMessages.delete(`${chatId}:${sentConfirmation.message_id}`);
                                this.sentConfirmations.delete(`${chatId}:${sentConfirmation.message_id}`);
                                console.log(`[${methodName}] Cleaned up progress messages for key: ${chatId}:${sentConfirmation.message_id}`);
                            }, 3000); // 3 seconds delay
                        } catch (error) {
                            console.error('Error deleting confirmation message:', error);
                        }
                    }
                }
            } catch (error) {
                logError(methodName, `Error handling message`, error as Error, { userId: userId, chatId });
                return "An unexpected error occurred while processing your message";
            }
        }
        return "handleMessage processed";
    }

    // TelegramBot_Agents.ts

    public async processMessage(
        adapter: ContextAdapter,
        message: Message,
        isAI: boolean,
        isReply: boolean,
        interactionType?: InteractionType,
        replyToMessage?: { message_id: number; text: string },
        progressKey?: string
    ): Promise<string> {
        const methodName = 'processMessage';
        const context = adapter.getMessageContext();

        if (!this.conversationManager || !this.agentManager || !this.promptManager) {
            logError(methodName, 'Essential managers are not initialized', new Error('Essential managers are null'));
            return "I'm sorry, but I'm not ready to process messages yet.";
        }

        const { userId, sessionId } = await this.conversationManager.getSessionInfo(adapter);
        logInfo(methodName, `Received message`, { userId, sessionId, source: context.source, isAI, isReply });


        // Type guards for different message types
        let userInput: string;

        // Type guards for different message types
        if ('text' in message) {
            userInput = message.text;
        } else if ('caption' in message && 'photo' in message) {
            // Photo message with caption
            userInput = message.caption || '';
        } else if ('caption' in message && 'video' in message) {
            // Video message with caption
            userInput = message.caption || '';
        } else if ('caption' in message && 'document' in message) {
            // Document message with caption
            userInput = message.caption || '';
        } else {
            logWarn(methodName, 'Received message is not a text or caption-based message', { userId, sessionId });
            return 'Sorry, I can only process text messages or media with captions.';
        }

        logDebug(methodName, `Processed user input`, { userId, sessionId, userInput: userInput });

        try {
            // Validate request (if needed)
            const validation = await this.accountManager.validateMessageRequest(
                userId,
                userInput,
                context.source,
                context.raw?.auth
            );

            if (!validation.isValid) {
                return validation.error || "Unable to process message";
            }

            if (isAI) {
                logInfo(methodName, `Processing AI message`, { userId, sessionId });
                await this.processAIMessage(adapter, userInput);
                return "AI message processed successfully";
            } else {
                const response = await this.prepareAndProcessUserInput(adapter, userInput, interactionType, progressKey);

                // Only update token usage for webapp source
                if (context.source === 'webapp') {
                    // Update token usage with response text
                    await this.accountManager.updateTokenUsageFromText(userId, response, context.source);

                    logInfo(methodName, `Response processed:`, {
                        responsePreview: response.substring(0, 100),
                        userId,
                        source: context.source
                    });
                }

                return response;
            }
        } catch (error) {
            logError(methodName, `Error processing message for user ${userId} in session ${sessionId}:`, error as Error);
            await this.handleProcessingError(adapter, error);
            return "An error occurred while processing your message. Please try again.";
        }
    }

    private async prepareAndProcessUserInput(
        adapter: ContextAdapter,
        input: string,
        interactionType?: InteractionType,
        progressKey?: string
    ): Promise<string> { // Ensure it returns string
        const methodName = 'prepareAndProcessUserInput';

        const context = adapter.getMessageContext();
        const { userId, chatId, isAI, isReply, replyToMessage } = context;
        const chatHistory = await this.getChatHistory(adapter);

        logInfo(methodName, `Preparing to process input`, {
            userId, chatId, isAI, isReply, inputPreview: input.substring(0, 100)
        });

        if (isAI === true) {
            await this.processAIMessage(adapter, input);
            const aiResponse = "AI message processed successfully";
            logInfo(methodName, `AI message processed`, { response: aiResponse });
            return aiResponse;
        } else {
            console.log(`[${methodName}:${this.flowId}] Calling processUserInput`);
            const enhancedResponse = await this.processUserInput(
                adapter,
                input,
                chatHistory,
                isAI,
                isReply,
                replyToMessage,
                false, // isFollowUp
                interactionType,
                progressKey
            );
            console.log(`[${methodName}:${this.flowId}] Received response from processUserInput`);

            const response = enhancedResponse.response.join('\n');
            logInfo(methodName, `Response from processUserInput:`, { responsePreview: response.substring(0, 100) });
            return response;
        }
    }

    public async processUserInput(
        adapter: ContextAdapter,
        input: string,
        chatHistory: BaseMessage[],
        isAI: boolean,
        isReply: boolean,
        replyToMessage?: { message_id: number; text: string },
        isFollowUp: boolean = false,
        interactionType?: InteractionType,
        progressKey?: string
    ): Promise<EnhancedResponse> {
        const methodName = 'processUserInput';
        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.conversationManager!.getSessionInfo(context);

        console.log(`[${methodName}:${this.flowId}] Starting for user input: "${input.substring(0, 50)}..."`);
        console.log(`[${methodName}:${this.flowId}] isAI: ${isAI}, isReply: ${isReply}, isFollowUp: ${isFollowUp}`);

        try {
            // Check game state first
            const gameAgent = this.agentManager.getAgent('game') as GameAgent;
            const gameState = gameAgent?.getGameState?.(userId);

            let enhancedResponse: EnhancedResponse;

            // Determine processing path
            if (gameState?.isActive) {
                // Game Processing Path
                const fullGameState = gameAgent.getGameState(userId, true);
                console.log(`[${methodName}:${this.flowId}] Processing game interaction`);
                enhancedResponse = await this.processGameInteraction(
                    adapter,
                    input,
                    chatHistory,
                    isReply,
                    userId,
                    fullGameState!,
                    gameAgent,
                    replyToMessage,
                    progressKey
                );
            } else {
                // Normal Chat Processing Path
                console.log(`[${methodName}:${this.flowId}] Processing normal chat interaction`);
                enhancedResponse = await this.processNormalInteraction(
                    adapter,
                    input,
                    chatHistory,
                    isReply,
                    userId,
                    replyToMessage,
                    isFollowUp,
                    interactionType,
                    progressKey
                );
            }

            // Handle response and memory updates
            const responseMessageId = await this.handleEnhancedResponse(adapter, enhancedResponse, progressKey);

            // Update memory
            await this.updateMemoryWithResponse(
                adapter,
                input,
                enhancedResponse,
                context,
                userId,
                sessionId,
                isReply,
                isFollowUp,
                replyToMessage,
                responseMessageId
            );

            return enhancedResponse;
        } catch (error) {
            logError(methodName, `Error processing input:`, error as Error, { userId, sessionId });
            throw error;
        }
    }

    private async processGameInteraction(
        adapter: ContextAdapter,
        input: string,
        chatHistory: BaseMessage[],
        isReply: boolean,
        userId: string,
        gameState: GameState,
        gameAgent: GameAgent,
        replyToMessage?: { message_id: number; text: string },
        progressKey?: string
    ): Promise<EnhancedResponse> {
        if (progressKey) {
            await this.updateProgress(adapter, progressKey, "🎮 Processing game action...");
        }

        // Let the game agent handle the interaction
        const gameResponse = await this.conversationManager!.generateResponse(
            input,
            chatHistory,
            isReply,
            userId,
            adapter,
            replyToMessage,
            progressKey
        );

        return {
            response: Array.isArray(gameResponse) ? gameResponse : [gameResponse],
            sourceCitations: undefined,
            followUpQuestions: undefined,
            externalAgentSuggestion: undefined,
            gameMetadata: {
                gameState: gameState,
                keyboard: gameAgent.createGameKeyboard(gameState)
            }
        };
    }

    private async processNormalInteraction(
        adapter: ContextAdapter,
        input: string,
        chatHistory: BaseMessage[],
        isReply: boolean,
        userId: string,
        replyToMessage?: { message_id: number; text: string },
        isFollowUp: boolean = false,
        interactionType?: InteractionType,
        progressKey?: string
    ): Promise<EnhancedResponse> {
        const isRAGEnabled = this.agentManager.isRAGModeEnabled(userId);

        if (isRAGEnabled) {
            if (progressKey) {
                await this.updateProgress(adapter, progressKey, "🖥 Generating with context...");
            }

            return await this.conversationManager!.processWithRAGAgent(
                input,
                chatHistory,
                interactionType!,
                userId,
                adapter,
                replyToMessage,
                progressKey
            );
        } else {
            if (progressKey) {
                await this.updateProgress(adapter, progressKey, "💭 Generating response...");
            }

            const response = await this.conversationManager!.generateResponse(
                input,
                chatHistory,
                isReply,
                userId,
                adapter,
                replyToMessage,
                progressKey
            );

            return {
                response: Array.isArray(response) ? response : [response],
                sourceCitations: undefined,
                followUpQuestions: undefined,
                externalAgentSuggestion: undefined,
                gameMetadata: {
                    gameState: null,
                    keyboard: null
                }
            };
        }
    }
    private async updateMemoryWithResponse(
        adapter: ContextAdapter,
        input: string,
        enhancedResponse: EnhancedResponse,
        context: MessageContext,
        userId: string,
        sessionId: string,
        isReply: boolean,
        isFollowUp: boolean,
        replyToMessage?: { message_id: number; text: string },
        responseMessageId?: number
    ): Promise<void> {
        const methodName = 'updateMemoryWithResponse';

        try {
            // Log message IDs for debugging
            logInfo(methodName, 'Message IDs for memory update:', {
                userMessageId: context.messageId,
                responseMessageId,
                replyToMessageId: replyToMessage?.message_id,
                sessionId,
                userId
            });

            // Validate message IDs
            const userMessageId = context.messageId ?
                (typeof context.messageId === 'string' ? parseInt(context.messageId) : context.messageId) :
                undefined;

            const validReplyToMessageId = replyToMessage?.message_id ?
                (typeof replyToMessage.message_id === 'string' ? parseInt(replyToMessage.message_id) : replyToMessage.message_id) :
                undefined;

            // Create messages with full context
            const messages: BaseMessage[] = [];

            // Add human message with full context
            messages.push(new HumanMessage(input, {
                additional_kwargs: {
                    message_id: userMessageId,
                    reply_to_message_id: validReplyToMessageId,
                    session_id: sessionId,
                    user_id: userId,
                    timestamp: new Date().toISOString(),
                    is_reply: isReply,
                    is_followup: isFollowUp
                }
            }));

            // Add AI message with full context
            messages.push(new AIMessage(enhancedResponse.response.join('\n'), {
                additional_kwargs: {
                    message_id: responseMessageId,
                    session_id: sessionId,
                    user_id: userId,
                    timestamp: new Date().toISOString(),
                    related_to_message_id: userMessageId,
                    is_followup_response: isFollowUp,
                    // Add game-specific metadata if it exists
                    game_state: enhancedResponse.gameMetadata?.gameState ?
                        JSON.stringify(enhancedResponse.gameMetadata.gameState) : undefined
                }
            }));

            // Update memory with validation
            try {
                await this.updateMemory(adapter, messages);
                logInfo(methodName, 'Memory updated successfully', {
                    userId,
                    sessionId,
                    messageCount: messages.length,
                    hasGameState: !!enhancedResponse.gameMetadata?.gameState
                });
            } catch (error) {
                logError(methodName, 'Error updating memory:', error as Error, {
                    userId,
                    sessionId,
                    messageIds: {
                        user: userMessageId,
                        response: responseMessageId,
                        replyTo: validReplyToMessageId
                    }
                });
                // Don't throw here - we want to continue even if memory update fails
            }
        } catch (error) {
            logError(methodName, 'Error in memory update process:', error as Error, {
                userId,
                sessionId
            });
            // Still don't throw - memory updates shouldn't break the main flow
        }
    }
    public async handleEnhancedResponse(adapter: ContextAdapter, enhancedResponse: EnhancedResponse, progressKey?: string): Promise<number | undefined> {
        const methodName = 'handleEnhancedResponse';
        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.conversationManager!.getSessionInfo(context);

        logInfo(methodName, `Processing enhanced response`, { userId, sessionId });

        try {
            // Check if this is a game response
            if (enhancedResponse.gameMetadata?.gameState) {
                logInfo(methodName, `Processing game response`, {
                    userId,
                    sessionId,
                    gameLevel: enhancedResponse.gameMetadata.gameState.currentLevel,
                    gameStatus: enhancedResponse.gameMetadata.gameState.status
                });

                if (progressKey && adapter) {
                    await this.updateProgress(adapter, progressKey, "🎮 Processing game response...");
                }

                // Check if we should skip sending the message (flag in gameState)
                if (enhancedResponse.gameMetadata.gameState.responseAlreadySent) {
                    console.log('[handleEnhancedResponse] Skipping game response send as it was already handled');
                    return enhancedResponse.gameMetadata.gameState.lastMessageId; // Return the messageId from gameState
                }

                // Add debug logging
                console.log('Game keyboard markup:', enhancedResponse.gameMetadata.keyboard);

                // Send response with game keyboard
                const response = await adapter.reply(
                    enhancedResponse.response.join('\n'),
                    {
                        reply_markup: enhancedResponse.gameMetadata.keyboard
                    }
                );

                return response.message_id;
            }
            // Check for pattern keyboard
            const patternKeyboard = this.conversationManager!.cache.get(`pattern_keyboard:${userId}`);
            if (patternKeyboard) {
                // Clear the keyboard from cache
                this.conversationManager!.cache.del(`pattern_keyboard:${userId}`);

                // Send response with pattern keyboard
                const sentMessage = await adapter.reply(
                    enhancedResponse.response.join('\n'),
                    {
                        parse_mode: 'Markdown',
                        reply_markup: patternKeyboard
                    }
                );
                return sentMessage.message_id;
            }
            // Handle non-game responses as before
            if (progressKey && adapter) {
                await this.updateProgress(adapter, progressKey, "💯 Enhanced Response ready to send...");
            }

            // Send the main response
            const messageId = await this.sendResponse(adapter, enhancedResponse.response);

            // Handle source citations - with null check
            if (enhancedResponse.sourceCitations && enhancedResponse.sourceCitations.length > 0) {
                logInfo(methodName, `Sending paginated citations`, {
                    userId,
                    sessionId,
                    citationCount: enhancedResponse.sourceCitations.length
                });
                if (progressKey && adapter) {
                    await this.updateProgress(adapter, progressKey, "📚 stacking source citations...");
                }
                await this.sendPaginatedCitations(adapter, enhancedResponse.sourceCitations);
            }

            // Handle follow-up questions - with null check
            if (enhancedResponse.followUpQuestions && enhancedResponse.followUpQuestions.length > 0) {
                logInfo(methodName, `Sending paginated follow-up questions`, {
                    userId,
                    sessionId,
                    questionCount: enhancedResponse.followUpQuestions.length
                });
                if (progressKey && adapter) {
                    await this.updateProgress(adapter, progressKey, "📚 stacking follow-up questions...");
                }
                await this.sendPaginatedQuestions(adapter, enhancedResponse.followUpQuestions);
            }

            // Handle external agent suggestion
            if (enhancedResponse.externalAgentSuggestion) {
                logInfo(methodName, `Sending external agent suggestion`, { userId, sessionId });
                await adapter.reply(`🤖 An external agent might be able to assist further: ${enhancedResponse.externalAgentSuggestion}`);
            }

            return messageId;
        } catch (error) {
            logError(methodName, `Error processing enhanced response`, error as Error, { userId, sessionId });
            await adapter.reply("I'm sorry, but I encountered an error while processing the response. Please try again.");
            return undefined;
        }
    }


    private async sendResponse(adapter: ContextAdapter, response: string | string[]): Promise<number | undefined> {
        const methodName = 'sendResponse';
        console.log(`[${methodName}:${this.flowId}:] Sending Response`);

        const responseChunks = Array.isArray(response) ? response : this.promptManager!.splitAndTruncateMessage(response);
        let lastMessageId: number | undefined;

        for (const chunk of responseChunks) {
            let formattedChunk: string;
            if (adapter.getMessageContext().source === 'telegram') {
                formattedChunk = FormatConverter.genericToHTML(chunk);
            } else {
                formattedChunk = FormatConverter.genericToMarkdown(chunk);
            }

            const sentMessage = await adapter.reply(formattedChunk, {
                parse_mode: adapter.getMessageContext().source === 'telegram' ? 'HTML' : undefined
            });
            lastMessageId = sentMessage.message_id;
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return lastMessageId;
    }

    // In TelegramBot_Agents.ts
    public formatResponse(
        input: string | FormattedResponse,
        context: MessageContext,
        stats?: {
            tokenUsage?: number;
            userStats?: UserStats;
        }
    ): string | FormattedResponse {
        const methodName = 'formatResponse';
        logInfo(methodName, 'Formatting response', {
            source: context.source,
            inputPreview: typeof input === 'string' ? input.substring(0, 100) : 'object'
        });

        switch (context.source) {
            case 'telegram':
                return typeof input === 'string' ? input : input.text || input.content || input.error || '';

            case 'webapp':
                // If input is already a formatted response, ensure text/content are strings
                if (typeof input !== 'string') {
                    if (input.requireAuth) {
                        return {
                            text: '🔒 Authentication Required',
                            content: '🔒 Authentication Required',
                            error: input.error,
                            requireAuth: true,
                            showAuthModal: true,
                            metadata: {
                                type: 'auth_error',
                                timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
                                ...input.metadata
                            },
                            question: context.input,
                            chatId: context.chatId,
                            chatMessageId: context.messageId || Date.now().toString(),
                            isStreamValid: false,
                            sessionId: context.chatId,
                            memoryType: this.memory
                        } as FormattedResponse;
                    }

                    // Ensure existing response has string text/content
                    return {
                        ...input,
                        text: this.ensureStringResponse(input.text),
                        content: this.ensureStringResponse(input.content)
                    };
                }

                // Create new response from string input
                return {
                    text: input,
                    content: input,
                    metadata: {
                        source: 'webapp',
                        timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
                        tokenStats: stats?.userStats ? {
                            quota: stats.userStats.token_quota,
                            used: stats.userStats.token_usage || 0,
                            remaining: stats.userStats.available_tokens || 0,
                            messages: stats.userStats.total_messages || 0,
                            lastReset: new Date(stats.userStats.last_reset || Date.now()).toISOString(),
                            nextReset: stats.userStats.next_reset_date ?
                                new Date(stats.userStats.next_reset_date).toISOString() :
                                null,
                            subscription: stats.userStats.subscription_tier
                        } : undefined
                    },
                    question: context.input,
                    chatId: context.chatId,
                    chatMessageId: context.messageId || Date.now().toString(),
                    isStreamValid: false,
                    sessionId: context.chatId,
                    memoryType: this.memory
                } as FormattedResponse;

            case 'flowise':
                // For flowise, maintain specific response structure
                return {
                    text: typeof input === 'string' ? input : input.text,
                    content: typeof input === 'string' ? input : input.content,
                    metadata: {
                        source: 'flowise',
                        timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
                    },
                    question: context.input,
                    chatId: context.chatId,
                    chatMessageId: context.messageId || Date.now().toString(),
                    isStreamValid: false,
                    sessionId: context.chatId,
                    memoryType: this.memory
                } as FormattedResponse;

            default:
                logWarn(methodName, `Unexpected message source`, { source: context.source });
                return input;
        }
    }
    private async handleFollowUpQuestion(adapter: ContextAdapter, question: string, interactionType?: InteractionType): Promise<void> {
        const methodName = 'handleFollowUpQuestion';
        const context = adapter.getMessageContext();
        const userId = context.userId.toString();
        const chatId = context.chatId.toString();

        let sentConfirmation: { message_id: number } | undefined;
        let progressKey: string | undefined;

        try {
            logInfo(methodName, `Processing follow-up question`, { question, userId, chatId });

            // Send initial confirmation message
            const confirmationMessage = this.getRandomConfirmationMessage();
            const sentMessage = await adapter.reply(confirmationMessage);
            sentConfirmation = { message_id: sentMessage.message_id };

            // Generate the progressKey using the sent message's ID
            progressKey = `${chatId}:${sentMessage.message_id}`;

            // Update progress
            await adapter.updateProgress(this.flowId, progressKey, "🤔 Thinking about your follow-up question...");

            // Get chat history
            const chatHistory = await this.getChatHistory(adapter);

            // Process the question
            const enhancedResponse = await this.processUserInput(
                adapter,
                question,
                chatHistory,
                false, // isAI
                true,  // isReply
                undefined, // replyToMessage
                true, // isFollowUp
                interactionType!,
                progressKey // Pass the progressKey here
            );

            // Handle the response
            //await this.handleEnhancedResponse(adapter, enhancedResponse, progressKey);

            logInfo(methodName, 'Follow-up question processed successfully', { question, userId, chatId });

        } catch (error) {
            logError(methodName, 'Error processing follow-up question', error as Error, { userId, chatId });
            await adapter.reply("I'm sorry, but I encountered an error while processing your follow-up question. Please try asking again.");
        } finally {
            if (sentConfirmation) {
                try {
                    await adapter.deleteMessage(sentConfirmation.message_id);
                } catch (error) {
                    logError(methodName, 'Error deleting confirmation message', error as Error, { userId, chatId });
                }
            }
        }
    }

    private async handleSpecialCases(adapter: ContextAdapter, text: string, isGroup: boolean, botUsername: string): Promise<boolean> {
        const methodName = 'handleSpecialCases';
        console.log(`[${methodName}] Entering handleSpecialCases`);

        const context = adapter.getMessageContext();

        // Handle "Start" commands for different bots
        if (isGroup && (text.startsWith('Start ') || text.startsWith('/start'))) {
            const botName = text.startsWith('Start ') ? text.substring(6) : text.split('@')[1];
            const allBotInfo = this.getAllBotInfo();
            const currentBotInfo = allBotInfo.find(bot => bot.id === this.bot?.botInfo?.id);

            const selectedBot = botName ? allBotInfo.find(bot => bot.firstName === botName || bot.username === botName) : currentBotInfo;

            if (selectedBot && selectedBot.id === currentBotInfo?.id) {
                await this.commandHandler.executeCommandByName(adapter, 'start');
            } else if (selectedBot) {
                const startCommand = `/start@${selectedBot.username}`;
                await adapter.reply(`🚀 To activate ${selectedBot.firstName}, please click or tap this command: ${startCommand}`);
            } else {
                await adapter.reply("❌ I couldn't find that bot. Please try again.");
            }
            return true;
        }

        // Handle keyboard menu options
        // Handle keyboard menu options
        if (text.toLowerCase().includes('show commands') || text.toLowerCase().includes('show_commands')) {
            console.log('[handleSpecialCases] Processing show commands request');
            const botId = this.bot?.botInfo?.id;

            if (!botId) {
                console.warn('[handleSpecialCases] Bot ID not available for show commands action');
                await adapter.reply("Unable to show commands. Bot ID not found.");
                return true;
            }

            try {
                await this.commandHandler.showCommandMenu(adapter, botId);
                return true;
            } catch (error) {
                console.error('[handleSpecialCases] Error showing command menu:', error);
                await adapter.reply("Sorry, there was an error displaying the commands menu.");
                return true;
            }
        }

        if (text.startsWith('Help') || text.startsWith('help_command')) {
            await this.commandHandler.executeCommandByName(adapter, 'help');
            return true;
        }

        // Handle commands
        if (text.startsWith('/')) {
            if (isGroup && !this.isCommandForThisBot(text, botUsername)) {
                console.log(`Command not for this bot: ${text}`);
                return false;
            }

            const [fullCommand, ...args] = text.split(' ');
            const [commandName] = fullCommand.slice(1).split('@');

            // Special handling for game commands
            if (commandName === 'millionaire') {
                if (this.commandHandler) {
                    try {
                        await this.commandHandler.executeCommandByName(adapter, commandName);
                        // Return false to continue processing through the normal pipeline
                        return false;
                    } catch (error) {
                        console.error(`Error executing game command ${commandName}:`, error);
                        await adapter.reply("I'm sorry, but I encountered an error while processing your command. Please try again later.");
                        return true;
                    }
                }
            }

            if (this.commandHandler) {
                try {
                    await this.commandHandler.executeCommandByName(adapter, commandName);
                } catch (error) {
                    console.error(`Error executing command ${commandName}:`, error);
                    await adapter.reply("I'm sorry, but I encountered an error while processing your command. Please try again later.");
                }
            } else {
                console.error('CommandHandler is not initialized');
                await adapter.reply("I'm sorry, but I'm not ready to process commands yet.");
            }
            return true;
        }

        return false;
    }

    private isCommandForThisBot(text: string, botUsername: string): boolean {
        const commandRegex = new RegExp(`^\/[a-z0-9_]+(@${botUsername})?($|\s)`, 'i');
        return commandRegex.test(text) && (!text.includes('@') || text.includes(`@${botUsername}`));
    }
    private async handleRagModeResponse(adapter: ContextAdapter, text: string): Promise<void> {
        const context = adapter.getMessageContext();
        const { userId } = await this.conversationManager!.getSessionInfo(context);

        this.conversationManager!.handleRagModeResponse(userId, text);
        let responseMessage: string;
        if (text.toLowerCase() === 'yes') {
            responseMessage = "RAG mode has been disabled. You can re-enable it anytime with the /ragmode command.";
        } else {
            responseMessage = "RAG mode remains enabled. Feel free to continue your conversation!";
        }

        // Send the response message
        await adapter.reply(responseMessage);

        // Restore the original keyboard
        const replyKeyboard = this.menuManager.createStartKeyboardMenu(adapter);
        await adapter.reply("Here's your original menu:", { reply_markup: replyKeyboard });
    }
    private async sendPaginatedCitations(adapter: ContextAdapter, citations: SourceCitation[]): Promise<void> {
        const context = adapter.getMessageContext();
        if (!context.chatId) {
            console.error('Context does not contain chat information');
            return;
        }

        const key = this.getCitationKey(context);
        let citationSets = this.userCitationSets.get(key);
        if (!citationSets) {
            citationSets = new Map();
            this.userCitationSets.set(key, citationSets);
        }

        const newSetId = Date.now().toString();

        const citationData: UserCitationData = {
            citations,
            currentPage: 0,
            lastActionTime: Date.now(),
            setId: newSetId,
            expirationTime: Date.now() + 48 * 60 * 60 * 1000, // 6 hours from now
            messageId: 0,
            chatId: typeof context.chatId === 'string' ? parseInt(context.chatId, 10) : context.chatId
        };

        citationSets.set(newSetId, citationData);

        console.log(`Generated new setId: ${newSetId} for citations in chat key: ${key}`);

        await this.sendPaginatedCitation(adapter, citationData, true);

        this.scheduleCitationSetCleanup(key, newSetId);
    }

    private async sendPaginatedCitation(adapter: ContextAdapter, citationData: UserCitationData, isInitialDisplay: boolean = false): Promise<void> {
        const { citations, currentPage, setId } = citationData;
        const totalPages = citations.length;
        const currentCitation = citations[currentPage];

        console.log(`Sending paginated citation. SetId: ${setId}, Page: ${currentPage + 1}/${totalPages}`);

        const escapeHTML = (text: string) => {
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        };

        let message = `📚 <b>Source Citation ${currentPage + 1} of ${totalPages}:</b>\n\n`;

        if (currentCitation.title) {
            message += `📙 <b>Title:</b> ${escapeHTML(currentCitation.title)}\n`;
        }

        if (currentCitation.fileName) {
            message += `🗂 <b>File:</b> ${escapeHTML(currentCitation.fileName)}\n`;
        }

        if (currentCitation.author) {
            message += `👤 <b>Author:</b> ${escapeHTML(currentCitation.author)}\n`;
        }

        if (currentCitation.relevance !== undefined) {
            message += `🎯 <b>Relevance Score:</b> ${currentCitation.relevance.toFixed(3)}\n`;
        }

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('⬅️ Previous', `prev_citation:${setId}`),
                Markup.button.callback('Next ➡️', `next_citation:${setId}`)
            ],
            [Markup.button.callback('Close Citations', `close_citations:${setId}`)]
        ]);

        try {
            if (isInitialDisplay) {
                const sentMessage = await adapter.replyWithHTML(message, { reply_markup: keyboard.reply_markup });
                citationData.messageId = sentMessage.message_id;
            } else if (adapter.context.raw?.callbackQuery && 'message' in adapter.context.raw.callbackQuery && adapter.context.raw.callbackQuery.message) {
                const editedMessage = await adapter.editMessageText(message, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard.reply_markup
                });
                if (typeof editedMessage === 'object' && 'message_id' in editedMessage) {
                    citationData.messageId = editedMessage.message_id;
                }
            } else {
                const sentMessage = await adapter.replyWithHTML(message, { reply_markup: keyboard.reply_markup });
                citationData.messageId = sentMessage.message_id;
            }
        } catch (error) {
            console.error('Error handling paginated citation:', error);
            try {
                const sentMessage = await adapter.replyWithHTML(message, { reply_markup: keyboard.reply_markup });
                citationData.messageId = sentMessage.message_id;
            } catch (retryError) {
                console.error('Error sending citation after initial failure:', retryError);
            }
        }
    }


    private async sendPaginatedQuestions(adapter: ContextAdapter, questions: string[]): Promise<void> {
        const context = adapter.getMessageContext();
        if (!context.chatId) {
            console.error('Context does not contain chat information');
            return;
        }

        const key = this.getChatKey(context);
        let questionSets = this.userQuestionSets.get(key);
        if (!questionSets) {
            questionSets = new Map();
            this.userQuestionSets.set(key, questionSets);
        }

        const newSetId = Date.now().toString();

        const questionData: UserQuestionData = {
            questions,
            currentPage: 0,
            lastActionTime: Date.now(),
            setId: newSetId,
            expirationTime: Date.now() + 48 * 60 * 60 * 1000, // 48 hours from now
            messageId: 0,
            chatId: this.parseId(context.chatId)
        };

        questionSets.set(newSetId, questionData);

        console.log(`Generated new setId: ${newSetId} for chat key: ${key}`);

        await this.sendPaginatedQuestion(adapter, questionData, true);

        this.scheduleQuestionSetCleanup(key, newSetId);
    }

    private async sendPaginatedQuestion(adapter: ContextAdapter, questionData: UserQuestionData, isInitialDisplay: boolean = false): Promise<void> {
        const { questions, currentPage, setId } = questionData;
        const totalPages = questions.length;
        const currentQuestion = questions[currentPage];

        console.log(`Sending paginated question. SetId: ${setId}, Page: ${currentPage + 1}/${totalPages}`);

        let message = `💡 <b>Follow-up Question ${currentPage + 1} of ${totalPages}:</b>\n\n${currentQuestion}`;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('⬅️ Previous', `prev_question:${setId}`),
                Markup.button.callback('Next ➡️', `next_question:${setId}`)
            ],
            [Markup.button.callback('Select This Question', `select_question:${setId}`)],
            [Markup.button.callback('🔄 Toggle On/Off "RAG" Q&A Mode', `execute_command:${this.botId}:ragmode`)]
        ]);

        try {
            if (isInitialDisplay) {
                const sentMessage = await adapter.replyWithHTML(message, { reply_markup: keyboard.reply_markup });
                questionData.messageId = sentMessage.message_id;
            } else if (adapter.context.raw?.callbackQuery && 'message' in adapter.context.raw.callbackQuery && adapter.context.raw.callbackQuery.message) {
                const editedMessage = await adapter.editMessageText(message, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard.reply_markup
                });
                if (typeof editedMessage === 'object' && 'message_id' in editedMessage) {
                    questionData.messageId = editedMessage.message_id;
                }
            } else {
                const sentMessage = await adapter.replyWithHTML(message, { reply_markup: keyboard.reply_markup });
                questionData.messageId = sentMessage.message_id;
            }
        } catch (error) {
            console.error('Error handling paginated question:', error);
            try {
                const sentMessage = await adapter.replyWithHTML(message, { reply_markup: keyboard.reply_markup });
                questionData.messageId = sentMessage.message_id;
            } catch (retryError) {
                console.error('Error sending question after initial failure:', retryError);
            }
        }
    }
    private confirmationMessages: string[] = [
        "🤔 Processing your request, please wait...",
        "🔍 I'm working on that for you. This might take a moment...",
        "🧠 Analyzing your message. I'll respond shortly...",
        "💡 Thinking... I'll have an answer for you soon.",
        "⏳ Your request is being processed. Thank you for your patience.",
        "🚀 I'm on it! Give me a few seconds to formulate a response.",
        "🔢 Calculating the best response for you. Won't be long!",
        "🤓 Hmm, that's an interesting one. Let me think about it...",
        "📩 Request received! I'm processing it now.",
        "⚙️ Working on your query. I'll be with you in a moment."
    ];
    private getCitationKey(context: MessageContext): number {
        if (!context.chatId) throw new Error('Chat ID not found');
        if (context.source === 'telegram' && context.raw?.chat?.type === 'private') {
            if (!context.userId) throw new Error('User ID not found');
            return this.parseId(context.userId);
        } else {
            return this.parseId(context.chatId);
        }
    }

    private getChatKey(context: MessageContext): number {
        const chatId = context.chatId;
        if (typeof chatId === 'undefined') {
            throw new Error('Chat ID not found');
        }
        if (context.source === 'telegram' && context.raw?.chat?.type === 'private') {
            const userId = context.userId;
            if (typeof userId === 'undefined') {
                throw new Error('User ID not found');
            }
            return this.parseId(userId);
        } else {
            return this.parseId(chatId);
        }
    }
    private scheduleCitationSetCleanup(key: number, setId: string): void {
        const citationSets = this.userCitationSets.get(key);
        const citationData = citationSets?.get(setId);
        if (!citationData) return;

        const timeUntilExpiration = citationData.expirationTime - Date.now();
        setTimeout(() => {
            this.cleanupCitationSet(key, setId);
        }, timeUntilExpiration);
    }

    private async cleanupCitationSet(key: number, setId: string): Promise<void> {
        const citationSets = this.userCitationSets.get(key);
        const citationData = citationSets?.get(setId);
        if (citationData) {
            try {
                if (this.bot) {
                    await this.bot.telegram.deleteMessage(citationData.chatId, citationData.messageId);
                }
            } catch (error) {
                console.error(`Failed to delete citation message for key ${key}, setId ${setId}:`, error);
            } finally {
                citationSets?.delete(setId);
                if (citationSets?.size === 0) {
                    this.userCitationSets.delete(key);
                }
            }
        }
        console.log(`Cleaned up citation set for key ${key}, setId ${setId}`);
    }
    private scheduleQuestionSetCleanup(key: number, setId: string): void {
        const questionSets = this.userQuestionSets.get(key);
        const questionData = questionSets?.get(setId);
        if (!questionData) return;

        const timeUntilExpiration = questionData.expirationTime - Date.now();
        setTimeout(() => {
            this.cleanupQuestionSet(key, setId);
        }, timeUntilExpiration);
    }

    private async cleanupQuestionSet(key: number, setId: string): Promise<void> {
        const questionSets = this.userQuestionSets.get(key);
        const questionData = questionSets?.get(setId);
        if (questionData) {
            try {
                if (this.bot) {
                    await this.bot.telegram.deleteMessage(questionData.chatId, questionData.messageId);
                }
            } catch (error) {
                console.error(`Failed to delete question message for key ${key}, setId ${setId}:`, error);
            } finally {
                questionSets?.delete(setId);
                if (questionSets?.size === 0) {
                    this.userQuestionSets.delete(key);
                }
            }
        }
        console.log(`Cleaned up question set for key ${key}, setId ${setId}`);
    }

    public getRandomConfirmationMessage(): string {
        const randomIndex = Math.floor(Math.random() * this.confirmationMessages.length);
        return this.confirmationMessages[randomIndex];
    }
    public setConversationManager(manager: ConversationManager): void {
        this.conversationManager = manager;
    }
    private updateUserActivity(userId: number): void {
        this.userLastActivity.set(userId, Date.now());
    }

    private isUserSessionExpired(userId: number): boolean {
        const lastActivity = this.userLastActivity.get(userId);
        if (!lastActivity) return false;
        return (Date.now() - lastActivity) / 1000 > this.idleTimeout;
    }

    private async handleSessionExpired(adapter: ContextAdapter): Promise<void> {
        await adapter.reply("⏰ Your session has expired due to inactivity. Please start a new conversation.");
        // Optionally, clear the user's conversation history here
    }

    public getAllKnownBots(): { id: number; username?: string; first_name?: string }[] {
        const allBots = this.botIds.map(id => ({ id }));
        if (this.bot && this.bot.botInfo) {
            allBots.push({
                id: this.bot.botInfo.id,
                ...(this.bot.botInfo.username && { username: this.bot.botInfo.username }),
                ...(this.bot.botInfo.first_name && { first_name: this.bot.botInfo.first_name })
            });
        }
        return allBots;
    }
    private async isBotInGroup(chatId: string | number, userId: string | number): Promise<boolean> {
        if (chatId === undefined || userId === undefined) {
            console.error('chatId or userId is undefined');
            return false;
        }
        console.log(`Checking if user ${userId} is a bot in chat ${chatId}`);

        if (!this.bot || this.botId === null) {
            console.error('Bot is not properly initialized');
            return false;
        }

        const numericChatId = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
        const numericUserId = typeof userId === 'string' ? parseInt(userId, 10) : userId;

        if (isNaN(numericChatId) || isNaN(numericUserId)) {
            console.error('Invalid chatId or userId');
            return false;
        }

        if (numericUserId === this.botId) {
            console.log(`User ${userId} is this bot, not considering as external bot`);
            return false;
        }

        let members = this.groupMembers.get(numericChatId);
        if (!members) {
            console.log(`No members found for chat ${chatId}, initializing`);
            members = new Map();
            this.groupMembers.set(numericChatId, members);
        }

        let memberInfo = members.get(numericUserId);
        if (!memberInfo) {
            console.log(`User ${userId} not found in cache, fetching info`);
            try {
                const chatMember = await this.bot.telegram.getChatMember(numericChatId, numericUserId);
                console.log(`Chat member info for ${userId}:`, JSON.stringify(chatMember, null, 2));

                memberInfo = {
                    is_bot: chatMember.user.is_bot,
                    is_admin: ['administrator', 'creator'].includes(chatMember.status)
                };
                members.set(numericUserId, memberInfo);

                console.log(`User ${userId} is bot: ${memberInfo.is_bot}, is admin: ${memberInfo.is_admin}`);
            } catch (error) {
                console.error(`Error fetching info for user ${userId}:`, error);
                return false;
            }
        } else {
            console.log(`User ${userId} found in cache`);
        }

        console.log(`User ${userId} is bot: ${memberInfo.is_bot}, is admin: ${memberInfo.is_admin}`);
        return memberInfo.is_bot;
    }

    private isAIUser(user: User | undefined): boolean {
        if (!user) return false;

        const userId = user.id;
        const username = user.username?.toLowerCase() || '';

        // Check known bot IDs (if we decide to keep this feature)
        if (this.knownBotIds && this.knownBotIds.has(userId)) return true;

        // Check username patterns
        if (username.endsWith('bot')) return true;

        // Check for specific bot-like properties
        if (user.is_bot) return true;

        // Additional heuristics can be added here
        // For example, checking for specific patterns in the first_name or last_name

        return false;
    }

    public async updateMemory(adapter: ContextAdapter, messages: BaseMessage[], messageId?: number): Promise<void | { sessionId: string }> {
        const methodName = 'updateMemory';

        // Early validation
        if (!messages?.length || !this.conversationManager || !this.memory) {
            logInfo(methodName, 'Skipping memory update - invalid inputs or not initialized');
            return;
        }

        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.conversationManager.getSessionInfo(context);
        // Check if this is a game interaction by looking at game state
        const gameAgent = this.agentManager?.getAgent('game') as GameAgent;
        if (gameAgent) {
            const gameState = gameAgent.getGameState(userId);
            if (gameState && gameState.isActive) {
                console.log(`[${methodName}] Skipping memory update for active game`);
                return; // Skip memory update entirely for game interactions
            }
        }
        try {
            logDebug(methodName, `Updating memory`, {
                userId,
                sessionId,
                source: context.source,
                messageId
            });

            // First check if session exists
            let session;
            try {
                session = await this.memory.getChatMessagesExtended(userId, sessionId);
            } catch (error) {
                // If session doesn't exist, try to create it
                if (error?.message?.includes('not found')) {
                    logDebug(methodName, `Session not found, creating new session`, {
                        userId,
                        sessionId
                    });

                    // Initialize session if memory supports it
                    if (typeof this.memory.saveContext === 'function') {
                        await this.memory.saveContext(
                            { userId, sessionId },
                            { init: true }
                        );
                    }
                } else {
                    throw error;
                }
            }

            // Convert messages to ExtendedIMessage format
            const extendedMessages: ExtendedIMessage[] = messages
                .filter(msg => msg.content)
                .flatMap((message, index) => {
                    const content = message.content as string;
                    const isHuman = message.getType() === 'human';

                    return this.splitMessage(content, 1000).map((chunk, chunkIndex) => ({
                        message: chunk,
                        text: chunk,
                        type: isHuman ? 'userMessage' as MessageType : 'apiMessage' as MessageType,
                        input: isHuman ? chunk : '',
                        output: !isHuman ? chunk : '',
                        metadata: {
                            userId,
                            sessionId,
                            timestamp: Date.now(),
                            messageId,
                            index,
                            chunkIndex
                        }
                    }));
                });

            if (!extendedMessages.length) {
                logInfo(methodName, 'No valid messages to update');
                return;
            }

            // Add messages to memory
            await this.memory.addChatMessagesExtended(extendedMessages, userId, sessionId);

            logDebug(methodName, `Memory updated successfully`, {
                userId,
                sessionId,
                messageCount: extendedMessages.length,
                source: context.source
            });

            return context.source === 'flowise' ? { sessionId } : undefined;

        } catch (error) {
            logError(methodName, 'Error updating memory:', error as Error, {
                userId,
                sessionId,
                source: context.source
            });
        }
    }
    // flowise chats, delete chat history
    public async clearChatHistory(adapter: ContextAdapter): Promise<void> {
        const methodName = 'clearChatHistory';
        const context = adapter.getMessageContext();
        if (!this.conversationManager || !this.memory) {
            logError(methodName, 'ConversationManager or Memory is not initialized', new Error('ConversationManager or Memory is null'));
            return;
        }

        const { userId, sessionId } = await this.conversationManager.getSessionInfo(context);

        try {
            if (context.source === 'flowise') {
                // For Flowise, use only the sessionId
                await this.memory.clearChatMessages(sessionId);
                logDebug(methodName, `Flowise chat history cleared`, { sessionId });
            } else {
                // For non-Flowise sessions, use the combined userId:sessionId
                const combinedSessionId = `${userId}:${sessionId}`;
                await this.memory.clearChatMessages(combinedSessionId);
                logDebug(methodName, `Chat history cleared`, { userId, sessionId });
            }
        } catch (error) {
            logError(methodName, `Error clearing chat history`, error as Error, { userId, sessionId });
        }
    }
    public async getChatHistory(adapter: ContextAdapter): Promise<BaseMessage[]> {
        const methodName = 'getChatHistory';
        const context = adapter.getMessageContext();

        if (!this.conversationManager || !this.memory) {
            logError(methodName, 'ConversationManager or Memory is not initialized', new Error('ConversationManager or Memory is null'));
            return [];
        }

        const { userId, sessionId } = await this.conversationManager!.getSessionInfo(adapter);
        logDebug(methodName, `Starting to retrieve chat history for user ${userId} in session ${sessionId}`);

        // Dump all messages before retrieval if using MemoryManager
        if (this.memory instanceof MemoryManager) {
            logInfo(methodName, 'Using MemoryManager, dumping all messages');
            this.memory.dumpAllMessages();
        }

        try {

            const messages = await this.memory.getChatMessagesExtended(userId, sessionId) as ExtendedIMessage[];
            logDebug(methodName, `Retrieved ${messages.length} messages for user ${userId} in session ${sessionId}`);

            // Log each retrieved message
            messages.forEach((msg, index) => {
                console.log(`[getChatHistory] Raw message ${index + 1}:`, JSON.stringify(msg, null, 2));
            });

            const baseMessages = this.convertToBaseMessages(messages);
            logDebug(methodName, `Converted ${baseMessages.length} messages to BaseMessage format`);

            // Log each converted message
            baseMessages.forEach((msg, index) => {
                if (!this.conversationManager) {
                    logError(methodName, 'ConversationManager', new Error('ConversationManager is null'));
                    return;
                }
                console.log(`[getChatHistory] Converted message ${index + 1}:`, JSON.stringify({
                    type: msg.getType(),
                    content: this.conversationManager.getContentPreview(msg.content),
                    additional_kwargs: msg.additional_kwargs
                }, null, 2));
            });

            const serializedHistory = this.serializeChatHistory(baseMessages);
            logDebug(methodName, `Serialized chat history: ${serializedHistory}`);

            return baseMessages;
        } catch (error) {
            logError(methodName, `Error retrieving chat history for user ${userId} in session ${sessionId}:`, error as Error);
            return [];
        }
    }


    private serializeChatHistory(chatHistory: BaseMessage[]): string {
        console.log(`[serializeChatHistory] Starting serialization of ${chatHistory.length} messages`);

        const serialized = JSON.stringify(chatHistory.map((msg, index) => {
            const serializedMsg = {
                type: msg.getType(),
                content: msg.content
            };
            console.log(`[serializeChatHistory] Serialized message ${index + 1}: ${JSON.stringify(serializedMsg)}`);
            return serializedMsg;
        }));

        console.log(`[serializeChatHistory] Completed serialization, result length: ${serialized.length} characters`);
        return serialized;
    }



    private parseWebappChatId(chatId: string): WebappChatIdData | null {
        try {
            // Expected format: webapp|userId|firstName|sessionId
            // e.g., "webapp|1414981328|Marcus|424ac03a-8b26-4d23-bc9c-60571ce39a6b"
            const parts = chatId.split('|');
            if (parts[0] === 'webapp' && parts.length >= 4) {
                return {
                    source: 'webapp',
                    userId: parts[1],
                    firstName: parts[2],
                    sessionId: parts[3]
                };
            }
            return null;
        } catch {
            return null;
        }
    }

    public async run(
        nodeData: INodeData,
        input: string | SafeOptions,
        options: ICommonObject
    ): Promise<string | ICommonObject> {
        const methodName = 'run';

        try {
            // Detailed input logging
            logInfo(methodName, 'Raw input received:', {
                inputType: typeof input,
                isString: typeof input === 'string',
                isObject: typeof input === 'object' && input !== null,
                isEmpty: typeof input === 'string' && input.trim() === '',
                rawValue: typeof input === 'string' ? input : JSON.stringify(input),
                hasCommand: typeof input === 'object' && input !== null && 'command' in input,
                command: typeof input === 'object' && input !== null && 'command' in input ? input.command : undefined
            });

            // Null check with logging
            if (input === null || input === undefined) {
                logInfo(methodName, 'Early return - null input', {
                    isNull: input === null,
                    isUndefined: input === undefined
                });
                return {
                    text: '',
                    error: 'No input provided'
                };
            }
            // If input is an empty string but options contain command data
            if (typeof input === 'string' && input.trim() === '' && options) {
                logInfo(methodName, 'Checking options for command data:', {
                    hasCommand: 'command' in options,
                    command: options.command,
                    hasParams: !!options.commandParams
                });

                // If we find command data in options, construct proper input object
                if ('command' in options && options.command?.startsWith('conversation_')) {
                    input = {
                        question: '',
                        command: options.command,
                        commandParams: options.commandParams,
                        sessionId: options.sessionId || `session_${options.chatflowid || 'default'}`,
                        userId: options.userId || '',
                        chatId: options.chatId || `chat_${options.chatflowid || 'default'}`,
                        source: options.source || 'webapp',
                        chatType: options.chatType || 'private',
                        messageId: Date.now(),
                        auth: options.auth
                    };

                    logInfo(methodName, 'Reconstructed input from options:', {
                        hasCommand: true,
                        command: input.command,
                        source: input.source
                    });
                }
            }
            // Create safe options object without circular references early
            const safeOptions = Object.keys(options).reduce((acc, key) => {
                if (key !== 'logger' && key !== 'appDataSource' && typeof options[key] !== 'function') {
                    acc[key] = options[key];
                }
                return acc;
            }, {} as ICommonObject);

            const chatflowid = safeOptions.chatflowid || 'default_chatflow';
            const botKey = chatflowid;
            const flowId = getOrCreateFlowId(botKey);

            // Parse input if it's a JSON string
            let parsedInput: SafeOptions;
            if (typeof input === 'string') {
                try {
                    // Check for encoded command in question field
                    const commandData = this.decodeCommand(input.trim());
                    if (commandData) {
                        logInfo(methodName, 'Detected encoded command:', {
                            command: commandData.command,
                            hasParams: !!commandData.params,
                            params: commandData.params
                        });

                        // Parse webapp data from chatId first
                        const webappData = options.chatId ? this.parseWebappChatId(options.chatId) : null;
                        if (webappData) {
                            logInfo(methodName, 'Found webapp user data:', {
                                userId: webappData.userId,
                                firstName: webappData.firstName,
                                sessionId: webappData.sessionId
                            });

                            const normalizedUserId = `tg_${webappData.userId}`;

                            // Create SafeOptions with command data and user info
                            parsedInput = {
                                question: input,  // Keep original encoded command
                                sessionId: webappData.sessionId,
                                userId: normalizedUserId,
                                chatId: options.chatId,
                                source: 'webapp',
                                chatType: 'private',
                                messageId: Date.now(),
                                command: commandData.command,
                                commandParams: commandData.params,
                                firstName: webappData.firstName,
                                auth: {
                                    type: AUTH_TYPES.TELEGRAM,
                                    id: normalizedUserId,
                                    username: webappData.firstName
                                }
                            };
                        } else {
                            // Fallback if no webapp data
                            parsedInput = {
                                question: input,
                                sessionId: options.sessionId || `session_${options.chatflowid || 'default'}`,
                                userId: options.userId || '',
                                chatId: options.chatId || `chat_${options.chatflowid || 'default'}`,
                                source: options.source || 'webapp',
                                chatType: options.chatType || 'private',
                                messageId: Date.now(),
                                command: commandData.command,
                                commandParams: commandData.params,
                                auth: options.auth
                            };
                        }
                    } else if (input.trim().startsWith('{')) {
                        logInfo(methodName, 'Attempting to parse JSON string');
                        const jsonParsed = JSON.parse(input);
                        if (typeof jsonParsed === 'object' && jsonParsed !== null) {
                            parsedInput = { ...jsonParsed };
                            logInfo(methodName, 'Successfully parsed JSON input:', {
                                hasCommand: 'command' in parsedInput,
                                command: parsedInput.command,
                                source: parsedInput.source
                            });
                        } else {
                            parsedInput = this.createDefaultSafeOptions(input, safeOptions);
                        }
                    } else {
                        parsedInput = this.createDefaultSafeOptions(input, safeOptions);
                    }
                } catch (err) {
                    logInfo(methodName, 'Input parsing failed:', {
                        error: err instanceof Error ? err.message : 'Unknown error',
                        input: input.length > 100 ? `${input.substring(0, 100)}...` : input
                    });
                    parsedInput = this.createDefaultSafeOptions(input, safeOptions);
                }
            } else {
                parsedInput = { ...input };
            }


            // Log final parsed input state
            logInfo(methodName, 'Final parsed input state:', {
                source: parsedInput.source,
                userId: parsedInput.userId,
                hasAuth: !!parsedInput.auth,
                command: parsedInput.command,
                hasParams: !!parsedInput.commandParams
            });

            // Early command detection and handling
            if ('command' in parsedInput && parsedInput.command?.startsWith('conversation_')) {
                if (this.isValidConversationOperation(parsedInput.command)) {
                    logInfo(methodName, 'Command-only payload detected:', {
                        command: parsedInput.command,
                        hasParams: !!parsedInput.commandParams,
                        userId: parsedInput.userId
                    });

                    // Initialize bot for command handling
                    let telegramBot: TelegramBot_Agents | undefined;
                    const botKey = safeOptions.chatflowid || 'default_chatflow';
                    const flowId = getOrCreateFlowId(botKey);

                    if (!botInitializationLocks[botKey]) {
                        botInitializationLocks[botKey] = new Mutex();
                    }

                    await botInitializationLocks[botKey].runExclusive(async () => {
                        logInfo(methodName, 'Starting bot initialization for command');
                        telegramBot = await this.getOrCreateBotInstance(botKey, flowId, nodeData, safeOptions);
                    });

                    if (!telegramBot) {
                        throw new Error("Failed to initialize bot for command handling");
                    }

                    // For command-only requests, skip memory update
                    const commandOptions = {
                        ...safeOptions,
                        skipMemoryUpdate: true
                    };

                    // Handle command directly
                    return await telegramBot.executeRun(nodeData, parsedInput, commandOptions);
                } else {
                    logWarn(methodName, 'Invalid conversation command:', { command: parsedInput.command });
                }
            }
            // Initialize bot with mutex lock
            let telegramBot: TelegramBot_Agents | undefined;
            if (!botInitializationLocks[botKey]) {
                botInitializationLocks[botKey] = new Mutex();
            }

            await botInitializationLocks[botKey].runExclusive(async () => {
                logInfo(methodName, 'Starting bot initialization');
                telegramBot = await this.getOrCreateBotInstance(botKey, flowId, nodeData, options);
                logInfo(methodName, 'Bot initialization complete:', {
                    success: !!telegramBot,
                    isInitialized: telegramBot?.isInitialized,
                    isRunning: telegramBot?.isRunning
                });
            });

            if (!telegramBot) {
                throw new Error("Failed to retrieve or initialize bot instance.");
            }

            // Store chatflowId if not already set
            if (!this.chatflowId && options.chatflowId) {
                this.chatflowId = options.chatflowId;
                logInfo(methodName, 'Setting chatflow ID:', { chatflowId: this.chatflowId });
            }

            // Check chatflow state before initialization
            if (this.chatflowId && this.chatflowPool) {
                const existingFlow = this.chatflowPool.activeChatflows[this.chatflowId];

                if (!existingFlow || !existingFlow.inSync) {
                    logInfo(methodName, 'Chatflow needs reinitialization:', {
                        chatflowId: this.chatflowId,
                        exists: !!existingFlow,
                        inSync: existingFlow?.inSync
                    });
                    this.isInitialized = false;
                } else {
                    logInfo(methodName, 'Using existing chatflow:', {
                        chatflowId: this.chatflowId,
                        inSync: true
                    });
                }
            }

            // Ensure initialization with current nodeData and options
            if (!this.isInitialized) {
                await this.ensureInitialization(nodeData, options);
            }

            // Check if this is an auth request
            if (typeof parsedInput === 'object' && 'type' in parsedInput && parsedInput.type === AUTH_TYPES.TELEGRAM) {
                logInfo(methodName, 'Processing auth request');

                // Create proper TelegramAuthData
                const telegramAuthData: TelegramAuthData = {
                    id: parseInt(parsedInput.userId),
                    first_name: parsedInput.firstName || '',
                    username: parsedInput.firstName || '',
                    auth_date: Math.floor(Date.now() / 1000),
                    hash: ''
                };

                const authRequest: AuthRequest = {
                    type: AUTH_TYPES.TELEGRAM,
                    data: telegramAuthData,
                    timestamp: Date.now(),
                    sessionId: parsedInput.sessionId || `session_${chatflowid}`,
                    metadata: {
                        chatflowId: chatflowid,
                        source: 'webapp',
                        webAuthData: {
                            type: AUTH_TYPES.TELEGRAM,
                            telegramUser: {
                                id: telegramAuthData.id,
                                username: telegramAuthData.username,
                                first_name: telegramAuthData.first_name
                            },
                            source: 'webapp'
                        } as WebAuthData
                    }
                };
                return await this.executeAuthRequest(authRequest, options);
            }

            // Try to parse webapp data from chatId
            const webappData = options.chatId ? this.parseWebappChatId(options.chatId) : null;
            if (webappData) {
                logInfo(methodName, 'Found webapp data in chatId', {
                    userId: webappData.userId,
                    firstName: webappData.firstName,
                    sessionId: webappData.sessionId
                });

                const normalizedUserId = `tg_${webappData.userId}`;
                const userRecord = await this.databaseService.getUserById(normalizedUserId);
                const hasValidToken = await this.databaseService.hasValidAuthToken(normalizedUserId);
                const userStats = await this.databaseService.getStatsForUser(normalizedUserId);

                if (!hasValidToken) {
                    const tokenStats = userRecord && userStats ? {
                        quota: userRecord.token_quota,
                        used: userStats.token_usage || 0,
                        remaining: userStats.available_tokens || 0,
                        total: userStats.total_tokens || 0,
                        messages: userStats.total_messages || 0,
                        lastReset: new Date(userStats.last_reset || Date.now()).toISOString(),
                        nextReset: userStats.next_reset_date ?
                            new Date(userStats.next_reset_date).toISOString() :
                            null,
                        subscription: userRecord.subscription_tier
                    } : null;

                    logInfo(methodName, 'Auth required for webapp access:', {
                        userId: normalizedUserId,
                        hasStats: !!tokenStats
                    });

                    return {
                        text: '🔒 Authentication Required',
                        error: 'Authentication required',
                        requireAuth: true,
                        showAuthModal: true,
                        metadata: {
                            type: 'auth_error',
                            timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
                            tokenStats
                        }
                    } as FormattedResponse;
                }

                logInfo(methodName, 'Proceeding with valid token:', {
                    userId: normalizedUserId,
                    sessionId: webappData.sessionId,
                    tokenQuota: userStats?.token_quota,
                    tokenUsage: userStats?.token_usage
                });

                // Update parsedInput with webapp data while preserving existing data
                parsedInput = {
                    ...parsedInput,
                    sessionId: webappData.sessionId,
                    userId: normalizedUserId,
                    chatId: options.chatId,
                    source: 'webapp', // Set source to webapp
                    chatType: 'private',
                    firstName: webappData.firstName,
                    auth: {
                        type: AUTH_TYPES.TELEGRAM,
                        id: normalizedUserId,
                        username: webappData.firstName
                    },
                    metadata: {
                        tokenStats: {
                            quota: userRecord.token_quota,
                            used: userStats.token_usage || 0,
                            remaining: userStats.available_tokens || 0,
                            total: userStats.total_tokens || 0,
                            messages: userStats.total_messages || 0,
                            lastReset: new Date(userStats.last_reset || Date.now()).toISOString(),
                            nextReset: userStats.next_reset_date ?
                                new Date(userStats.next_reset_date).toISOString() :
                                null,
                            subscription: userRecord.subscription_tier
                        }
                    }
                };
            } else if (!parsedInput.source) {
                // Only set source to flowise if not already set and not webapp
                parsedInput.source = 'flowise';
            }

            logInfo(methodName, 'Final input data', {
                source: parsedInput.source,
                userId: parsedInput.userId,
                chatId: parsedInput.chatId,
                hasAuth: !!parsedInput.auth
            });

            const enhancedOptions = parsedInput.source === 'webapp' ? {
                ...options,
                isWebApp: true,
                userId: parsedInput.userId,
                auth: parsedInput.auth
            } : options;

            return await telegramBot.executeRun(nodeData, parsedInput, enhancedOptions);

        } catch (error) {
            logError(methodName, `Error processing request`, error as Error);
            return formatResponse(`Failed to process request: ${error.message}`);
        }
    }



    private async getOrCreateBotInstance(
        botKey: string,
        flowId: string,
        nodeData: INodeData,
        options: ICommonObject
    ): Promise<TelegramBot_Agents | undefined> {
        const methodName = 'getOrCreateBotInstance';

        let bot = botInstanceCache.get<TelegramBot_Agents>(botKey);

        if (!bot) {
            logInfo(methodName, `Creating new bot instance`, { botKey, flowId });
            bot = new TelegramBot_Agents(flowId);
            try {
                await bot.init(nodeData, '', options);
                botInstanceCache.set(botKey, bot);
                logInfo(methodName, `Bot instance created and cached`, { botKey });
            } catch (error) {
                logError(methodName, `Error initializing bot`, error as Error);
                botInstanceCache.del(botKey);
                throw error;
            }
        } else {
            logInfo(methodName, `Retrieved existing bot instance`, { botKey });
        }

        return bot;
    }

    public async executeAuthRequest(request: AuthRequest, options: ICommonObject): Promise<ICommonObject> {
        const methodName = 'executeAuthRequest';
        try {
            logInfo(methodName, 'Processing auth request:', {
                type: request.type,
                hasData: !!request.data,
                hasToken: !!request.token
            });

            switch (request.type) {
                case AUTH_TYPES.TELEGRAM: {
                    const telegramData = request.data as TelegramAuthData;
                    if (!telegramData.id) {
                        return {
                            error: 'Missing Telegram user ID',
                            requireAuth: true
                        };
                    }

                    try {
                        // Use normalizeUserId for proper ID formatting (will add tg_ prefix)
                        const normalizedUserId = await this.databaseService.normalizeUserId(
                            telegramData.id.toString(),
                            AUTH_TYPES.TELEGRAM
                        );

                        logInfo(methodName, 'Processing user:', {
                            originalId: telegramData.id,
                            normalizedId: normalizedUserId
                        });

                        // Begin transaction
                        await this.databaseService.beginTransaction();

                        try {
                            // Check if user exists first
                            const existingUser = await this.databaseService.getUserById(normalizedUserId);

                            if (!existingUser) {
                                // Create user with proper DTO structure
                                const createUserDTO: CreateUserDTO = {
                                    id: normalizedUserId,  // Use normalized ID with tg_ prefix
                                    type: AUTH_TYPES.TELEGRAM,
                                    telegram_id: telegramData.id,
                                    telegram_username: telegramData.username || telegramData.first_name,
                                    subscription_tier: SUBSCRIPTION_TIERS.FREE,
                                    token_quota: this.databaseService.DEFAULT_TOKEN_QUOTA,
                                    metadata: {
                                        original_id: telegramData.id.toString(),
                                        source: 'webapp',
                                        created_at: new Date().toISOString(),
                                        auth_type: AUTH_TYPES.TELEGRAM,
                                        first_name: telegramData.first_name
                                    }
                                };

                                await this.databaseService.createUser(createUserDTO);

                                logInfo(methodName, 'Created new user:', {
                                    userId: normalizedUserId,
                                    type: AUTH_TYPES.TELEGRAM
                                });
                            }

                            // Generate new auth token using normalized ID
                            const token = await this.authService.generateTempAuthToken(normalizedUserId);

                            await this.databaseService.commitTransaction();

                            return {
                                success: true,
                                token,
                                userId: telegramData.id,
                                normalizedUserId  // Include normalized ID in response
                            };

                        } catch (error) {
                            await this.databaseService.rollbackTransaction();
                            throw error;
                        }
                    } catch (error) {
                        logError(methodName, 'Error creating user or token:', error as Error);
                        throw error;
                    }
                }

                case AUTH_TYPES.WALLET:
                case AUTH_TYPES.EMAIL:
                case AUTH_TYPES.FLOWISE:
                    return {
                        success: true,
                        source: request.type
                    };

                default:
                    return {
                        error: 'Unsupported auth type',
                        requireAuth: true
                    };
            }
        } catch (error) {
            logError(methodName, 'Auth request failed', error as Error);
            return {
                error: 'Auth request failed',
                requireAuth: true
            };
        }
    }

    /**
     * Executes the run operation for the TelegramBot_Agents class.
     *
     * This method is responsible for handling the execution of a message request, including:
     * - Ensuring the bot instance is properly initialized
     * - Handling web authentication for Flowise requests
     * - Creating a context adapter for the message
     * - Validating the message request
     * - Processing the message through the conversation manager and agent manager
     * - Updating the token usage for the user
     * - Formatting the response to be returned
     *
     * @param nodeData - The node data for the current execution.
     * @param input - The input message to be processed.
     * @param options - Additional options for the execution, such as the source of the request.
     * @returns The response from the bot, either as a string or an object.
     */
    // TelegramBot_Agents.ts

    private async executeRun(
        nodeData: INodeData,
        input: SafeOptions,
        options: ICommonObject
    ): Promise<string | ICommonObject> {
        const methodName = 'executeRun';
        console.log(`[executeRun] Entering executeRun`);
        try {
            const chatflowid = options.chatflowid;
            // Check for encoded command in question field first
            const commandData = typeof input.question === 'string' ?
                this.decodeCommand(input.question) : null;

            if (commandData) {
                logInfo(methodName, 'Processing encoded command:', {
                    command: commandData.command,
                    hasParams: !!commandData.params,
                    userId: input.userId
                });

                if (this.isValidConversationOperation(commandData.command)) {
                    // Process command parameters based on command type
                    let processedParams = { ...commandData.params };

                    // Handle special parameter processing for different commands
                    if (commandData.command === 'conversation_save') {
                        try {
                            // Parse messages if it's a string
                            if (typeof processedParams.messages === 'string') {
                                processedParams.messages = JSON.parse(processedParams.messages);
                                logInfo(methodName, 'Successfully parsed messages array:', {
                                    messageCount: processedParams.messages.length
                                });
                            }
                        } catch (err) {
                            logError(methodName, 'Failed to parse messages:', err as Error);
                            throw new Error('Invalid messages format');
                        }
                    }

                    try {
                        const commandResponse = await this.handleConversationCommand(
                            commandData.command,
                            processedParams,
                            input.userId?.toString() || ''
                        );

                        logInfo(methodName, 'Encoded command processed:', {
                            success: true,
                            hasMetadata: !!commandResponse.metadata,
                            responseKeys: Object.keys(commandResponse)
                        });

                        // Return command response without initializing message pipeline
                        return {
                            text: 'Command processed successfully',
                            content: 'Command processed successfully',
                            metadata: {
                                type: 'command_response',
                                command: commandData.command,
                                timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
                                ...commandResponse.metadata
                            },
                            chatId: input.chatId,
                            chatMessageId: input.messageId?.toString() || Date.now().toString(),
                            isStreamValid: false,
                            sessionId: input.sessionId,
                            source: input.source,
                            memoryType: this.memory
                        } as FormattedResponse;
                    } catch (error) {
                        logError(methodName, 'Command processing error:', error as Error);
                        return {
                            text: 'Failed to process command',
                            content: 'Failed to process command',
                            error: error instanceof Error ? error.message : 'Unknown error',
                            metadata: {
                                type: 'command_error',
                                command: commandData.command,
                                timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
                            },
                            chatId: input.chatId,
                            chatMessageId: input.messageId?.toString() || Date.now().toString(),
                            isStreamValid: false,
                            sessionId: input.sessionId,
                            source: input.source,
                            memoryType: this.memory
                        } as FormattedResponse;
                    }
                }
            }
            // If no encoded command, check for direct command            
            if ('command' in input && input.command?.startsWith('conversation_')) {
                logInfo(methodName, 'Processing conversation command', {
                    command: input.command,
                    hasParams: !!input.commandParams,
                    userId: input.userId
                });

                const commandResponse = await this.handleConversationCommand(
                    input.command,
                    input.commandParams,
                    input.userId?.toString() || ''
                );

                logInfo(methodName, 'Conversation command processed', {
                    success: true,
                    hasMetadata: !!commandResponse.metadata,
                    responseKeys: Object.keys(commandResponse)
                });

                // Return command response without initializing message pipeline
                return {
                    text: 'Command processed successfully',
                    content: 'Command processed successfully',
                    metadata: {
                        type: 'command_response',
                        command: input.command,
                        timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
                        ...commandResponse.metadata
                    },
                    chatId: input.chatId,
                    chatMessageId: input.messageId?.toString() || Date.now().toString(),
                    isStreamValid: false,
                    sessionId: input.sessionId,
                    source: input.source,
                    memoryType: this.memory
                } as FormattedResponse;
            }


            // Create message context based on source
            /**
             * Creates a message context object based on the provided SafeOptions data.
             * The message context is used to represent the incoming message and associated metadata.
             *
             * @param data - The SafeOptions data containing the message details.
             * @returns The created MessageContext object.
             */
            const createMessageContext = (data: SafeOptions): MessageContext => {
                return {
                    source: data.source,
                    chatId: data.chatId,
                    messageId: data.messageId,
                    userId: data.userId,
                    username: data.firstName,  // Use firstName as username if available
                    first_name: data.firstName,
                    input: data.question,     // The actual input string
                    raw: {
                        message: {
                            text: data.question,
                            message_id: typeof data.messageId === 'string' ? parseInt(data.messageId) : data.messageId || Date.now(),
                            date: Math.floor(Date.now() / 1000),
                            chat: {
                                id: data.chatId,
                                type: data.chatType,
                                // Add any additional chat properties from data if available
                                ...(data.raw?.chat || {})
                            },
                            from: {
                                id: typeof data.userId === 'string' ? parseInt(data.userId) : data.userId,
                                is_bot: false,
                                first_name: data.firstName || '',
                                username: data.firstName,  // Use firstName as username if available
                                // Add any additional user properties from data if available
                                ...(data.raw?.from || {})
                            }
                        },
                        chat: {
                            id: data.chatId,
                            type: data.chatType,
                            // Add any additional chat properties from data if available
                            ...(data.raw?.chat || {})
                        },
                        from: {
                            id: typeof data.userId === 'string' ? parseInt(data.userId) : data.userId,
                            is_bot: false,
                            first_name: data.firstName || '',
                            username: data.firstName,
                            // Add any additional user properties from data if available
                            ...(data.raw?.from || {})
                        },
                        flowwise_chatflow_id: data.chatflowId,
                        metadata: {
                            chatflowId: data.chatflowId,
                            auth: data.auth,
                            source: data.source
                        }
                    },
                    // Optional callback query data
                    callbackQuery: data.callbackQuery,
                    isAI: false,
                    isReply: false,
                    replyToMessage: data.replyToMessage
                };
            };
            let inputData: SafeOptions;
            const webappData = options.chatId ? this.parseWebappChatId(options.chatId) : null;

            if (webappData) {
                // Use normalized userId with tg_ prefix
                const normalizedUserId = `tg_${webappData.userId}`;

                logInfo(methodName, 'Processing webapp request:', {
                    userId: normalizedUserId,
                    firstName: webappData.firstName,
                    sessionId: webappData.sessionId
                });

                // Use normalized ID for token validation
                const hasValidToken = await this.databaseService.hasValidAuthToken(normalizedUserId);
                if (!hasValidToken) {
                    logInfo(methodName, 'Auth required for webapp access:', {
                        userId: normalizedUserId
                    });
                    return {
                        error: 'Invalid or expired token',
                        requireAuth: true,
                        question: typeof input === 'string' ? input : input.question,
                        chatId: options.chatId,
                        chatMessageId: options.messageId,
                        isStreamValid: false,
                        sessionId: options.chatId,
                        memoryType: this.memory
                    };
                }

                inputData = {
                    question: typeof input === 'string' ? input : (input as SafeOptions).question,
                    sessionId: webappData.sessionId,
                    userId: normalizedUserId,  // Use normalized ID
                    chatId: options.chatId,
                    source: 'webapp',  // Keep webapp as source
                    chatType: 'private',
                    messageId: Date.now().toString(),
                    firstName: webappData.firstName,
                    auth: {
                        type: AUTH_TYPES.TELEGRAM,  // Use telegram auth type
                        id: normalizedUserId,
                        username: webappData.firstName
                    },
                    interface: 'webapp'  // Track the interface in inputData
                };

            } else if (options.source === AUTH_TYPES.TELEGRAM) {
                const normalizedUserId = `tg_${options.userId}`;

                inputData = {
                    question: typeof input === 'string' ? input : (input as SafeOptions).question,
                    sessionId: options.sessionId || `session_${chatflowid}`,
                    userId: normalizedUserId,
                    chatId: options.chatId || '',
                    source: AUTH_TYPES.TELEGRAM,  // Keep telegram as source
                    chatType: options.chatType || 'private',
                    messageId: options.messageId?.toString() || Date.now().toString(),
                    firstName: options.firstName,
                    auth: {
                        type: AUTH_TYPES.TELEGRAM,
                        id: normalizedUserId,
                        username: options.firstName || ''
                    }
                };
            } else {
                // Flowise case remains the same
                inputData = {
                    question: typeof input === 'string' ? input : (input as SafeOptions).question,
                    sessionId: `session_${chatflowid}`,
                    userId: options.userId || '',
                    chatId: options.chatId || `chat_${chatflowid}`,
                    source: 'flowise',
                    chatType: 'private',
                    messageId: Date.now().toString(),
                    auth: {
                        type: 'flowise',
                        id: options.userId || '',
                        username: 'flowise_user'
                    }
                };
            }

            // Create context with proper typing
            const context = createMessageContext(inputData);

            // Create session data
            const now = new Date().toISOString();
            const sessionData: SessionInfo = {
                id: inputData.sessionId,
                userId: inputData.userId,  // Already normalized
                sessionId: inputData.sessionId,
                type: inputData.chatType,
                source: inputData.source,  // Keep original source (webapp/telegram)
                chat_id: inputData.chatId,
                flowwiseChatflowId: chatflowid,
                created_at: now,
                last_active: now,
                expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                status: 'active',
                auth: {
                    type: inputData.auth?.type || inputData.source,
                    id: inputData.userId,
                    username: inputData.auth?.username || inputData.firstName || `${inputData.source}_user`
                },
                metadata: {
                    chatflowid,
                    original_request: inputData,
                    auth_type: inputData.auth?.type,
                    lastActive: now,
                    requiresAuth: inputData.source === 'webapp'  // Auth required for webapp source
                }
            };

            logInfo(methodName, 'Creating session with data', {
                sessionId: sessionData.sessionId,
                userId: sessionData.userId,
                chatId: sessionData.chat_id,
                source: sessionData.source,
                requiresAuth: sessionData.metadata.requiresAuth
            });

            // Add validation before creating session
            if (!sessionData.chat_id) {
                logWarn(methodName, 'Missing chat_id, using fallback', {
                    sessionId: sessionData.sessionId,
                    source: sessionData.source
                });
                sessionData.chat_id = sessionData.sessionId;
            }

            // Get or create session
            const session = await this.databaseService.getOrCreateSession(
                sessionData,
                inputData.source === 'flowise'  // Skip user creation for flowise source
            );

            const adapter = new ContextAdapter(context, this.promptManager!);

            // Get session info
            const sessionInfo = await this.conversationManager!.getSessionInfo(adapter);

            // Process the message
            const aiResponse = await this.handleMessage(adapter, this.conversationManager!, this.agentManager);

            // Handle different response types based on source
            if (context.source === 'webapp') {
                try {
                    const normalizedUserId = inputData.userId; // Already normalized above

                    // Get user stats once
                    const userStats = await this.accountManager.getUserStats(normalizedUserId);
                    const responseText = this.ensureStringResponse(aiResponse);

                    // Base metadata
                    const metadata: any = {
                        source: 'webapp',
                        timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
                    };

                    // Add token stats if available
                    if (userStats) {
                        const QUOTA = 25000; // Set consistent quota
                        metadata.tokenStats = {
                            quota: QUOTA,
                            used: userStats.token_usage || 0,
                            remaining: Math.max(0, QUOTA - (userStats.token_usage || 0)),
                            messages: userStats.total_messages || 0,
                            lastReset: new Date(userStats.last_reset || Date.now()).toISOString(),
                            nextReset: userStats.next_reset_date ?
                                new Date(userStats.next_reset_date).toISOString() :
                                null,
                            subscription: userStats.subscription_tier
                        };

                        logInfo(methodName, 'Token stats prepared:', {
                            subscription: userStats.subscription_tier,
                            quota: metadata.tokenStats.quota,
                            used: metadata.tokenStats.used,
                            remaining: metadata.tokenStats.remaining
                        });
                    }


                    // Regular message response
                    return {
                        text: responseText,
                        content: responseText,
                        metadata,
                        question: (input as SafeOptions).question,
                        chatId: options.chatId,
                        chatMessageId: options.messageId || Date.now().toString(),
                        isStreamValid: false,
                        sessionId: options.chatId,
                        memoryType: this.memory
                    } as FormattedResponse;

                } catch (error) {
                    logError(methodName, 'Error in webapp response:', error as Error);
                    return {
                        text: this.ensureStringResponse(aiResponse),
                        content: this.ensureStringResponse(aiResponse),
                        metadata: {
                            source: 'webapp',
                            timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
                        },
                        error: 'Error processing request',
                        question: (input as SafeOptions).question,
                        chatId: options.chatId,
                        chatMessageId: options.messageId || Date.now().toString(),
                        isStreamValid: false,
                        sessionId: options.chatId,
                        memoryType: this.memory
                    } as FormattedResponse;
                }
            } else if (context.source === 'flowise') {
                return {
                    text: aiResponse,
                    content: aiResponse,
                    metadata: {
                        source: 'flowise',
                        timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
                    },
                    question: context.input,
                    chatId: context.chatId,
                    chatMessageId: context.messageId || Date.now().toString(),
                    isStreamValid: false,
                    sessionId: context.chatId,
                    memoryType: this.memory
                } as FormattedResponse;
            }

            return this.formatResponse(aiResponse, context);
        } catch (error) {
            logError(methodName, 'Error in executeRun:', error as Error);
            throw error;
        }
    }

    private async ensureInitialization(nodeData: INodeData, options: ICommonObject): Promise<void> {
        const methodName = 'ensureInitialization';
        logInfo(methodName, 'Starting initialization check...', {
            isInitialized: this.isInitialized,
            isRunning: this.isRunning,
            initializing: this.initializing,
            hasDatabase: !!this.databaseService
        });

        // If already running and initialized with services
        if (this.isInitialized && this.isRunning && this.databaseService) {
            logInfo(methodName, 'Bot is already initialized and running');
            return;
        }

        // If initialization is in progress, wait for it
        if (this.initializing) {
            logInfo(methodName, 'Initialization in progress. Waiting for completion...');
            await this.waitForInitialization();
            logInfo(methodName, 'Initialization wait completed');
            return;
        }

        // Initialize if not initialized, not running, or missing services
        if (!this.isInitialized || !this.isRunning || !this.databaseService) {
            logInfo(methodName, 'Starting initialization...', {
                reason: !this.isInitialized ? 'Not initialized' :
                    !this.isRunning ? 'Not running' :
                        'Missing services'
            });

            try {
                this.initializing = true;

                await this.init(nodeData, '', options);
                this.isInitialized = true;
                this.isRunning = true;

                // Verify services after initialization
                if (!this.databaseService) {
                    throw new Error('Database service not initialized');
                }

                logInfo(methodName, 'Initialization completed successfully');
            } catch (error) {
                logError(methodName, 'Initialization failed:', error as Error);
                throw error;
            } finally {
                this.initializing = false;
            }
        } else {
            logInfo(methodName, 'Already in valid state, no action needed');
        }

        logInfo(methodName, 'Initialization check finished', {
            isInitialized: this.isInitialized,
            isRunning: this.isRunning,
            initializing: this.initializing,
            hasDatabase: !!this.databaseService
        });
    }

    private createMessageContext(input: SafeOptions): MessageContext {
        return {
            source: input.source,
            chatId: input.chatId,
            messageId: input.messageId,
            userId: input.userId,
            username: input.firstName,
            first_name: input.firstName,
            input: input.question,
            raw: {
                message: {
                    text: input.question,
                    message_id: typeof input.messageId === 'string' ? parseInt(input.messageId) : input.messageId || Date.now(),
                    date: Math.floor(Date.now() / 1000),
                    chat: {
                        id: input.chatId,
                        type: input.chatType,
                        ...(input.raw?.chat || {})
                    },
                    from: {
                        id: typeof input.userId === 'string' ? parseInt(input.userId) : input.userId,
                        is_bot: false,
                        first_name: input.firstName || '',
                        username: input.firstName,
                        ...(input.raw?.from || {})
                    }
                },
                chat: {
                    id: input.chatId,
                    type: input.chatType,
                    ...(input.raw?.chat || {})
                },
                from: {
                    id: typeof input.userId === 'string' ? parseInt(input.userId) : input.userId,
                    is_bot: false,
                    first_name: input.firstName || '',
                    username: input.firstName,
                    ...(input.raw?.from || {})
                },
                flowwise_chatflow_id: input.chatflowId,
                metadata: {
                    chatflowId: input.chatflowId,
                    auth: input.auth,
                    source: input.source
                }
            },
            callbackQuery: input.callbackQuery,
            isAI: false,
            isReply: false,
            replyToMessage: undefined
        };
    }

    private parseId(id: string | number | undefined): number {
        if (typeof id === 'number') {
            return id;
        }
        if (typeof id === 'string') {
            const parsed = parseInt(id, 10);
            if (!isNaN(parsed)) {
                return parsed;
            }
        }
        return Date.now(); // Fallback to current timestamp if parsing fails
    }
    // Helper method to ensure response text/content are strings
    private ensureStringResponse(response: string | FormattedResponse | any): string {
        if (typeof response === 'string') {
            return response;
        }
        if (typeof response === 'object') {
            return response.text || response.content || '';
        }
        return '';
    }


    public async initializeTelegramUser(adapter: ContextAdapter): Promise<UserAccount> {
        const methodName = 'initializeTelegramUser';
        const context = adapter.getMessageContext();
        const telegramId = typeof context.userId === 'string' ? parseInt(context.userId) : context.userId;

        try {
            // Ensure database is initialized
            await this.databaseService.initialize();

            const normalizedUserId = `tg_${telegramId}`;
            console.log(`[${methodName}] Initializing user:`, {
                telegramId,
                normalizedUserId,
                username: context.username
            });
            const userData: CreateUserDTO = {
                id: `telegram_${telegramId}`,
                type: AUTH_TYPES.TELEGRAM,
                telegram_id: telegramId,
                telegram_username: context.username || undefined,  // Ensure undefined instead of null
                subscription_tier: SUBSCRIPTION_TIERS.FREE,
                token_quota: this.DEFAULT_TOKEN_QUOTA,
                metadata: {
                    auth_timestamp: Date.now(),
                    auth_type: AUTH_TYPES.TELEGRAM,
                    first_name: context.raw?.from?.first_name,
                    source: 'telegram'
                }
            };

            // Create or get user
            const userRecord = await this.databaseService.getOrCreateUser(userData);
            console.log(`[${methodName}] User record created/retrieved:`, {
                userId: userRecord.id,
                type: userRecord.type
            });

            // Only after user is created, handle auth tokens
            if (userRecord) {
                try {
                    const authTokens = await this.authService.authenticateTelegram({
                        id: telegramId,
                        username: context.username
                    });

                    // Store the tokens
                    await this.databaseService.storeAuthTokens(
                        userRecord.id,
                        authTokens.accessToken,
                        authTokens.refreshToken
                    );
                } catch (tokenError) {
                    // Log token error but don't fail the whole initialization
                    console.warn(`Token generation failed but user was created:`, tokenError);
                }
            }
            const user = await this.databaseService.getUserById(userRecord.id);
            // Get user stats
            const userStats = await this.databaseService.getStatsForUser(userRecord.id);

            // Construct UserAccount with proper typing
            const userAccount: UserAccount = {
                id: userRecord.id,
                type: userRecord.type as AuthType,
                telegramId: telegramId,  // Use the original telegramId
                telegramUsername: context.username || undefined,
                subscription_tier: userRecord.subscription_tier,
                token_quota: user.token_quota,
                token_usage: userRecord.token_usage || 0,  // Ensure number
                tokens_purchased: userRecord.tokens_purchased || 0,
                created_at: new Date(userRecord.created_at || Date.now()),
                last_active: new Date(userRecord.last_active || Date.now()),
                last_reset: new Date(userRecord.last_reset || Date.now()),
                metadata: {
                    auth_timestamp: Date.now(),
                    auth_type: AUTH_TYPES.TELEGRAM,
                    auth_data: {
                        id: telegramId,
                        username: context.username,
                        first_name: context.raw?.from?.first_name
                    },
                    source: 'telegram',
                    deviceInfo: context.raw?.from?.language_code ? {
                        language: context.raw.from.language_code
                    } : undefined
                },
                stats: {
                    id: userRecord.id,
                    subscription_tier: userRecord.subscription_tier,
                    token_quota: user.token_quota,
                    token_usage: userStats.token_usage || 0,
                    total_tokens: userStats.total_tokens || 0,
                    total_messages: userStats.total_messages || 0,
                    available_tokens: userStats.available_tokens || 0,
                    last_reset: new Date(userStats.last_reset || Date.now()),
                    next_reset_date: userStats.next_reset_date ? new Date(userStats.next_reset_date) : null,
                    last_active: new Date(userStats.last_active || Date.now()),
                    active_sessions: userStats.active_sessions || 0,
                    telegram_username: context.username || ''  // Required by UserStats interface
                }
            };

            // Initialize auth tokens
            await this.authService.authenticateTelegram({
                id: telegramId,
                username: context.username,
                // first_name: context.raw?.from?.first_name
            });

            logInfo(methodName, 'Telegram user initialized successfully', {
                userId: userAccount.id,
                telegramId: userAccount.telegramId
            });

            return userAccount;

        } catch (error) {
            console.error(`[${methodName}] Failed to initialize telegram user:`, {
                error,
                telegramId,
                username: context.username
            });
            throw error;
        }
    }

    private async handleConversationCommand(
        command: ConversationOperation,
        params: any,
        userId: string
    ): Promise<Partial<FormattedResponse>> {
        const methodName = 'handleConversationCommand';

        if (!command || !userId) {
            const error = new Error('Missing required parameters');
            logError(methodName, 'Invalid parameters:', error, { command, userId });
            return {
                error: 'Missing required parameters',
                metadata: {
                    errorDetails: {
                        code: 'INVALID_PARAMETERS',
                        message: 'Command and userId are required'
                    }
                }
            };
        }

        try {
            logInfo(methodName, 'Processing command:', {
                command,
                userId,
                hasParams: !!params
            });

            // If params is a SafeOptions object with a question field, try to decode it
            if (params && typeof params === 'object' && 'question' in params) {
                const decodedCommand = this.decodeCommand(params.question);
                if (decodedCommand) {
                    console.log(`[${methodName}] Decoded command from question:`, decodedCommand);
                    command = decodedCommand.command;
                    params = decodedCommand.params;
                }
            }

            // Validate and transform parameters
            if (params) {
                console.log(`[${methodName}] Original parameters:`, params);

                // Handle numeric parameters
                if ('limit' in params && typeof params.limit === 'string') {
                    params.limit = parseInt(params.limit, 10);
                }
                if ('offset' in params && typeof params.offset === 'string') {
                    params.offset = parseInt(params.offset, 10);
                }

                // Ensure tags is always an array
                if (command === 'conversation_save') {
                    if (!params.tags) {
                        params.tags = [];
                    } else if (!Array.isArray(params.tags)) {
                        params.tags = [params.tags].filter(Boolean);
                    }

                    // Validate messages array
                    if (!Array.isArray(params.messages)) {
                        throw new Error('Messages must be an array');
                    }
                }

                console.log(`[${methodName}] Parsed parameters:`, params);
            }

            if (!params) {
                throw new Error('No parameters provided for command');
            }

            // Validate command and parameters
            this.validateConversationCommand(command, params);

            // Check rate limits
            await this.checkRateLimit(userId, command);

            // Process command
            switch (command) {
                case 'conversation_list': {
                    const [conversations, total] = await Promise.all([
                        this.databaseService.getSavedConversations(
                            userId,
                            {
                                limit: params.limit,
                                offset: params.offset,
                                tag: params.tag,
                                favoritesOnly: params.favoritesOnly
                            }
                        ),
                        this.databaseService.getConversationCount(userId)
                    ]);

                    console.log(`[${methodName}] Retrieved conversations:`, conversations);

                    // Map conversations to include title
                    const conversationList = conversations.map(conv => {
                        const title = conv.title || 'Untitled Conversation';
                        console.log(`[${methodName}] Processing conversation:`, {
                            id: conv.id,
                            originalTitle: conv.title,
                            assignedTitle: title
                        });
                        return {
                            ...conv,
                            title
                        };
                    });

                    const hasTitle = conversationList.some(conv => conv.title && conv.title !== 'Untitled Conversation');
                    console.log(`[${methodName}] Processed conversations:`, {
                        total,
                        hasTitle,
                        conversationCount: conversationList.length
                    });

                    return {
                        metadata: {
                            conversations: {
                                list: conversationList,
                                total,
                                hasTitle
                            }
                        }
                    };
                }

                case 'conversation_save': {
                    const conversationId = await this.databaseService.saveConversation(
                        userId,
                        params.title,
                        params.messages,
                        {
                            description: params.description,
                            tags: params.tags,
                            isFavorite: params.isFavorite
                        }
                    );
                    return {
                        metadata: {
                            conversations: {
                                current: {
                                    id: conversationId,
                                    status: 'saved'
                                }
                            }
                        }
                    };
                }

                case 'conversation_load': {
                    const messages = await this.databaseService.getConversationMessages(
                        params.conversationId,
                        userId
                    );
                    return {
                        metadata: {
                            conversations: {
                                current: {
                                    id: params.conversationId,
                                    messages
                                }
                            }
                        }
                    };
                }

                case 'conversation_update': {
                    if (!params.conversationId) {
                        throw new Error('Conversation ID is required for update');
                    }

                    // Parse and sanitize messages
                    let messages: ConversationMessage[] = [];
                    try {
                        // Log initial state
                        logInfo(methodName, 'Processing messages input:', {
                            type: typeof params.messages,
                            isArray: Array.isArray(params.messages),
                            isString: typeof params.messages === 'string'
                        });

                        // Handle messages based on type
                        let rawMessages: RawMessageInput[] = [];
                        if (params.messages) {
                            if (Array.isArray(params.messages)) {
                                rawMessages = params.messages;
                            } else if (typeof params.messages === 'string') {
                                // If it's a string, try to parse it directly
                                rawMessages = JSON.parse(params.messages);
                                if (!Array.isArray(rawMessages)) {
                                    throw new Error('Parsed messages must be an array');
                                }
                            } else {
                                throw new Error('Messages must be an array or valid JSON string');
                            }
                        }

                        // Get current time in Brisbane timezone
                        const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });

                        // Process each message
                        messages = rawMessages.map((msg: RawMessageInput, index: number): ConversationMessage => {
                            // For new messages (those without timestamps), use current time
                            const isNewMessage = !msg.timestamp;

                            // Ensure we have the basic required fields
                            const processed: ConversationMessage = {
                                role: msg.role || 'user',
                                content: msg.content || msg.message || '',
                                timestamp: msg.timestamp || new Date().toISOString()
                            };

                            // Log each message processing
                            logInfo(methodName, `Processing message ${index}:`, {
                                originalRole: msg.role,
                                finalRole: processed.role,
                                contentLength: processed.content.length,
                                timestamp: processed.timestamp,
                                isNewMessage
                            });

                            return processed;
                        });

                        // Sort messages to ensure proper order
                        messages.sort((a, b) => {
                            const timeA = new Date(a.timestamp).getTime();
                            const timeB = new Date(b.timestamp).getTime();
                            return timeA - timeB;
                        });

                        // Log final message count and latest messages
                        const latestMessages = messages.slice(-2);
                        logInfo(methodName, 'Messages processed:', {
                            totalMessages: messages.length,
                            latestMessages: latestMessages.map(msg => ({
                                role: msg.role,
                                contentLength: msg.content.length,
                                timestamp: msg.timestamp
                            }))
                        });

                    } catch (error) {
                        logError(methodName, 'Failed to process messages:', error as Error, {
                            messageType: typeof params.messages,
                            isString: typeof params.messages === 'string',
                            isArray: Array.isArray(params.messages)
                        });
                        throw new Error(`Invalid message format: ${(error as Error).message}`);
                    }

                    // Single source of truth for update parameters
                    const updateOptions: Partial<SavedConversation> = {
                        title: params.title || undefined,
                        description: params.description || '',
                        tags: params.tags ? (Array.isArray(params.tags) ? params.tags : [params.tags]) : [],
                        isFavorite: params.isFavorite === 'true' ? true :
                            params.isFavorite === 'false' ? false :
                                params.isFavorite
                    };

                    // Log update operation
                    logInfo(methodName, 'Updating conversation:', {
                        conversationId: params.conversationId,
                        userId,
                        messageCount: messages.length,
                        ...updateOptions
                    });

                    // Perform update and get updated conversation
                    const updatedConversation = await this.databaseService.updateAndGetConversation(
                        params.conversationId,
                        userId,
                        messages,
                        updateOptions
                    );

                    // Log update verification
                    const updatedMessages = updatedConversation?.messages || [];
                    logInfo(methodName, 'Update verification:', {
                        conversationId: params.conversationId,
                        messageCount: updatedMessages.length,
                        latestMessages: updatedMessages.slice(-2).map(msg => ({
                            role: msg.role,
                            contentLength: msg.content.length,
                            timestamp: msg.timestamp
                        }))
                    });

                    const response: Partial<ConversationMetadata> = {
                        conversations: {
                            current: {
                                id: params.conversationId,
                                messages: updatedMessages
                            }
                        }
                    };

                    return {
                        metadata: response
                    };
                }

            }
        } catch (error) {
            // Enhanced error handling
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            const errorDetails = {
                code: error.name === 'RateLimitError' ? 'RATE_LIMIT_EXCEEDED' :
                    error.name === 'ValidationError' ? 'INVALID_PARAMETERS' :
                        'INTERNAL_ERROR',
                operation: command,
                timestamp: new Date().toISOString(),
                userId,
                flowId: this.flowId
            };

            // Enhanced error response with proper serialization
            const errorResponse: Partial<FormattedResponse> = {
                error: JSON.stringify({
                    name: error instanceof Error ? error.name : 'Error',
                    message: errorMessage,
                    details: errorDetails,
                    stack: error instanceof Error ? error.stack : undefined
                }, null, 2),
                metadata: {
                    errorDetails: {
                        command,
                        params: this.safeSerialize(params),
                        stackTrace: error instanceof Error ? error.stack : undefined,
                        timestamp: new Date().toISOString(),
                        flowId: this.flowId,
                        userId,
                        operation: command
                    },
                    method: 'handleConversationCommand',
                    message: 'Command processing failed'
                }
            };

            // Enhanced error logging
            const logDetails = {
                command,
                userId,
                flowId: this.flowId,
                params: this.safeSerialize(params),
                error: error instanceof Error ? {
                    name: error.name,
                    message: error.message,
                    stack: error.stack
                } : {
                    message: 'Unknown error',
                    rawError: error
                }
            };

            logError(methodName, 'Command processing failed:', error instanceof Error ? error : new Error('Unknown error'), logDetails);

            // Return structured error response
            return {
                ...errorResponse,
                metadata: {
                    ...errorResponse.metadata,
                    method: 'handleConversationCommand',
                    message: 'Command processing failed'
                }
            };
        }
    }


    private validateConversationCommand(command: string, params: any): void {
        const methodName = 'validateConversationCommand';

        switch (command) {
            case 'conversation_list':
                if (params.limit && (typeof params.limit !== 'number' || params.limit > 100)) {
                    throw new Error('Invalid limit parameter. Must be a number <= 100');
                }
                break;

            case 'conversation_save':
                if (!params.title?.trim()) {
                    throw new Error('Title is required for saving conversation');
                }
                if (!Array.isArray(params.messages) || params.messages.length === 0) {
                    throw new Error('Messages array is required and must not be empty');
                }
                break;

            case 'conversation_load':
                if (!params.conversationId?.trim()) {
                    throw new Error('Conversation ID is required');
                }
                break;

            case 'conversation_update':
                if (!params.conversationId?.trim()) {
                    throw new Error('Conversation ID is required for update');
                }
                if (!params.messages) {
                    throw new Error('Messages are required for update');
                }
                break;

            default:
                throw new Error(`Unknown conversation command: ${command}`);
        }
    }

    // Add rate limiting
    private async checkRateLimit(userId: string, operation: ConversationOperation): Promise<void> {
        const methodName = 'checkRateLimit';

        const limits: RateLimits = {
            'conversation_save': { max: 10, window: 60 * 60 }, // 10 saves per hour
            'conversation_list': { max: 30, window: 60 }, // 30 lists per minute
            'conversation_load': { max: 60, window: 60 }, // 60 loads per minute
            'conversation_update': { max: 30, window: 60 } // 30 updates per minute
        };

        const limit = limits[operation];
        if (!limit) {
            throw new Error(`Unknown operation: ${operation}`);
        }

        const key = `rate_limit:${userId}:${operation}`;
        const currentCount = await this.databaseService.getRateLimit(key);

        if (currentCount > limit.max) {
            throw new Error(`Rate limit exceeded for ${operation}`);
        }
    }

    private async triggerCleanup(): Promise<void> {
        const methodName = 'triggerCleanup';
        try {
            // Only run cleanup during low-usage hours
            const hour = new Date().getHours();
            if (hour >= 2 && hour <= 4) { // Between 2 AM and 4 AM
                await this.cleanupOldConversations();
            }
        } catch (error) {
            logError(methodName, 'Error triggering cleanup:', error as Error);
        }
    }

    private async cleanupOldConversations(): Promise<void> {
        const methodName = 'cleanupOldConversations';
        const CLEANUP_AGE = 60 * 24 * 60 * 60 * 1000; // 60 days

        try {
            const deletedCount = await this.databaseService.deleteOldConversations(CLEANUP_AGE);
            logInfo(methodName, `Cleaned up old conversations`, { deletedCount });

            // Also cleanup rate limits older than 24 hours
            await this.databaseService.cleanupRateLimits(24 * 60 * 60 * 1000);
        } catch (error) {
            logError(methodName, 'Error cleaning up conversations:', error as Error);
        }
    }

    // Update destroy method
    public destroy(): void {
        for (const buffer of this.updateBuffer.values()) {
            if (buffer.processingTimer) {
                clearTimeout(buffer.processingTimer);
            }
        }
        this.updateBuffer.clear();
        // Remove interval cleanup
        // if (this.cleanupInterval) {
        //     clearInterval(this.cleanupInterval);
        //     this.cleanupInterval = null;
        // }
    }

    // Helper function to safely serialize objects
    private safeSerialize(obj: any): any {
        const seen = new WeakSet();
        return JSON.parse(JSON.stringify(obj, (key, value) => {
            if (key === 'logger' || key === 'appDataSource') {
                return '[Circular]';
            }
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) {
                    return '[Circular]';
                }
                seen.add(value);
            }
            return value;
        }));
    }


    private isValidConversationOperation(command: string): command is ConversationOperation {
        const validOperations = [
            'conversation_list',
            'conversation_save',
            'conversation_load',
            'conversation_update'
        ] as const;

        console.log(`[TelegramBot] Validating conversation operation: ${command}`);
        const isValid = validOperations.includes(command as ConversationOperation);
        console.log(`[TelegramBot] Operation validation result: ${isValid}`);

        return validOperations.includes(command as ConversationOperation);
    }
    private createDefaultSafeOptions(
        input: string | SafeOptions,
        safeOptions: ICommonObject
    ): SafeOptions {
        if (typeof input === 'object' && input !== null) {
            // If input is already an object, preserve all properties
            return { ...input };
        }

        // If input is a string, create new SafeOptions
        return {
            question: typeof input === 'string' ? input : '',
            sessionId: `session_${safeOptions.chatflowid || 'default'}`,
            userId: '',
            chatId: safeOptions.chatId || `chat_${safeOptions.chatflowid || 'default'}`,
            source: 'flowise',
            chatType: 'private',
            messageId: Date.now(),
            // Include any command-related properties from options
            ...(safeOptions.command && { command: safeOptions.command }),
            ...(safeOptions.commandParams && { commandParams: safeOptions.commandParams })
        };
    }
    private decodeCommand(question: string | undefined): { command: ConversationOperation; params: any } | null {
        const methodName = 'decodeCommand';
        console.log(`[${methodName}] Attempting to decode:`, { question });

        if (!question || typeof question !== 'string') {
            console.log(`[${methodName}] Invalid input:`, { question });
            return null;
        }

        if (!question.startsWith('COMMAND:')) {
            console.log(`[${methodName}] Not a command string:`, { question });
            return null;
        }

        try {
            const [commandStr, ...paramParts] = question.slice('COMMAND:'.length).split('|');
            console.log(`[${methodName}] Split command parts:`, { commandStr, paramParts });

            // Validate command type
            if (!this.isValidConversationOperation(commandStr)) {
                console.log(`[${methodName}] Invalid command:`, { commandStr });
                throw new Error(`Invalid command: ${commandStr}`);
            }

            const params = paramParts.reduce((acc, param) => {
                const [key, value] = param.split('=');
                try {
                    if (key === 'messages') {
                        // Parse stringified message array
                        acc[key] = JSON.parse(value);
                    } else if (key === 'tags') {
                        // Convert tags string to array
                        acc[key] = value ? value.split(',').map(tag => tag.trim()) : [];
                    } else if (key === 'limit' || key === 'offset') {
                        // Parse numeric values
                        acc[key] = parseInt(value, 10);
                    } else {
                        acc[key] = value;
                    }
                } catch (parseError) {
                    console.warn(`[${methodName}] Error parsing parameter:`, { key, value, error: parseError });
                    acc[key] = value; // Keep original value on parse error
                }
                return acc;
            }, {} as Record<string, any>);

            console.log(`[${methodName}] Decoded command:`, { command: commandStr, params });

            return {
                command: commandStr as ConversationOperation,
                params
            };
        } catch (error) {
            logError(methodName, 'Failed to decode command:', error as Error);
            return null;
        }
    }

    private sanitizeMessageContent(content: string): string {
        if (!content) return '';

        try {
            const steps = [];
            let result = content;

            // Log initial state
            steps.push({
                step: 'initial',
                length: result.length,
                sample: result.substring(0, 50)
            });

            // Remove control characters
            result = result.replace(/[\u0000-\u0019]+/g, match =>
                match === '\n' ? '\n' : match === '\r' ? '\r' : match === '\t' ? '\t' : '');
            steps.push({
                step: 'remove_control',
                length: result.length,
                sample: result.substring(0, 50)
            });

            // Handle escaped characters
            result = result
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r')
                .replace(/\\t/g, '\t')
                .replace(/\\\\/g, '\\')
                .replace(/\\"/g, '"');

            steps.push({
                step: 'unescape',
                length: result.length,
                sample: result.substring(0, 50)
            });

            // Trim result
            result = result.trim();
            steps.push({
                step: 'trim',
                length: result.length,
                sample: result.substring(0, 50)
            });

            logInfo('sanitizeMessageContent', 'Content processing steps:', {
                steps,
                finalLength: result.length
            });

            return result;
        } catch (error) {
            logError('sanitizeMessageContent', 'Failed to sanitize content:', error as Error);
            return content.trim();
        }
    }


}

class SimpleInMemoryRetriever extends BaseRetriever {
    private documents: Document[];
    lc_namespace: string[] = ["langchain", "retrievers", "simple_memory"];

    constructor() {
        super();
        this.documents = [
            new Document({ pageContent: "Flowise is a drag & drop tool to build LLM apps", metadata: { source: "Flowise docs" } }),
            new Document({ pageContent: "LangChain is a framework for developing applications powered by language models", metadata: { source: "LangChain docs" } }),
            new Document({ pageContent: "Telegram is a cloud-based instant messaging service", metadata: { source: "Telegram website" } }),
        ];
    }

    async getRelevantDocuments(query: string): Promise<Document[]> {
        return this.documents.filter(doc =>
            doc.pageContent.toLowerCase().includes(query.toLowerCase())
        );
    }

}

module.exports = { nodeClass: TelegramBot_Agents }