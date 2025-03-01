import { Context, Telegraf, Markup } from 'telegraf';
import { ConversationManager } from './ConversationManager';
import { MessageType } from '../../../src/Interface'
import { IExtendedMemory, Command, ExtendedIMessage, SourceCitation, EnhancedResponse, BotInfo, InteractionType } from './commands/types';
//import * as commands from './commands';
import { BotCommand, Update, InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';
import { PromptManager } from './PromptManager';
import { AgentManager } from './AgentManager';
import { RAGAgent } from './agents/RAGAgent';
import { TelegramBot_Agents } from './TelegramBot_Agents';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage, MessageContent } from '@langchain/core/messages';
import { MenuManager, } from './MenuManager';
import { ContextAdapter, } from './ContextAdapter';
import { ExtraEditMessageText } from 'telegraf/typings/telegram-types';
import { ThinkingDisplayMode, ThinkingPreferences, ThinkingBlock } from './utils/types/ThinkingTypes';
import { GameAgent } from './agents/GameAgent';
import { PatternPromptAgent } from './agents/PatternPromptAgent';
import * as commandModules from './commands';
import {
    LifelineType,
    PatternContextData,
    PatternData
} from './commands/types';
import { fsync } from 'fs';



export class CommandHandler {
    private bot: Telegraf<Context>;
    private conversationManager: ConversationManager | null;
    private memory: IExtendedMemory | null;
    private promptManager: PromptManager | null;
    private agentManager: AgentManager | null;
    private telegramBot: TelegramBot_Agents | null;
    private botIds: number[] = [];
    private botCommandMenus: Map<number, Markup.Markup<InlineKeyboardMarkup>>;
    private botInfo: BotInfo[];
    private menuManager: MenuManager | null;
    private flowId: string;

    constructor(
        bot: Telegraf<Context>,
        conversationManager: ConversationManager | null,
        memory: IExtendedMemory | null,
        promptManager: PromptManager | null,
        agentManager: AgentManager | null,
        menuManager: MenuManager | null,
        flowId: string,
        config?: {
            telegramBot: TelegramBot_Agents,
        }

    ) {
        this.bot = bot;
        this.conversationManager = conversationManager;
        this.memory = memory;
        this.promptManager = promptManager;
        this.agentManager = agentManager;
        this.menuManager = menuManager;
        this.telegramBot = config?.telegramBot || null;
        this.botIds = this.telegramBot?.getBotIds() || [];
        this.botCommandMenus = new Map();
        this.botInfo = this.telegramBot?.getAllBotInfo() || [];
        this.flowId = flowId;
    }


    async hideCommandMenu(ctx: Context) {
        // Logic to remove the inline keyboard
    }
    public setConversationManager(conversationManager: ConversationManager) {
        this.conversationManager = conversationManager;
    }

    public setMemory(memory: IExtendedMemory) {
        this.memory = memory;
    }

    public setPromptManager(promptManager: PromptManager) {
        this.promptManager = promptManager;
    }

    public setAgentManager(agentManager: AgentManager) {
        this.agentManager = agentManager;
    }

    public setMenuManager(menuManager: MenuManager) {
        this.menuManager = menuManager;
    }

    async registerCommands(): Promise<void> {
        if (!this.conversationManager) {
            console.error('ConversationManager is not initialized. Cannot register commands.');
            return;
        }

        try {
            // Initialize bot commands array
            const botCommands: BotCommand[] = [];

            // Get commands only after all setup is complete
            const commands = Object.values(commandModules);

            if (!Array.isArray(commands)) {
                console.error('Commands not in array format. Received:', commands);
                return;
            }

            if (commands.length === 0) {
                console.warn('No commands to register.');
                return;
            }

            // Register each command
            for (const command of commands) {
                if (this.isValidCommand(command)) {
                    this.bot.command(command.name, async (ctx) => {
                        if (ctx.message && 'text' in ctx.message) {
                            const fullCommand = ctx.message.text.split(' ')[0];
                            const [commandName, targetBot] = fullCommand.split('@');
                            if (!targetBot || targetBot === this.bot.botInfo?.username) {
                                const adapter = new ContextAdapter(ctx, this.promptManager);
                                await this.executeCommand(adapter, command);
                            }
                        }
                    });
                    console.log(`Registered command: ${command.name}`);

                    botCommands.push({
                        command: command.name,
                        description: command.description
                    });
                } else {
                    console.error('Invalid command structure:', command);
                }
            }
            this.bot.action(/^millionaire_(.+)$/, async (ctx) => {
                const methodName = 'millionaireCallback';
                console.log(`[${methodName}] Processing millionaire callback`);

                const adapter = new ContextAdapter(ctx, this.promptManager);
                const userId = ctx.from?.id.toString();
                if (!userId) {
                    console.warn(`[${methodName}] Could not identify user from context`);
                    await adapter.reply("Could not identify user.");
                    return;
                }

                const command = ctx.match[1];
                console.log(`[${methodName}] Processing command: ${command} for user: ${userId}`);

                try {
                    await this.handleMillionaireCommand(adapter, command, userId);
                } catch (error) {
                    console.error(`[${methodName}] Error handling millionaire command:`, error);
                    await adapter.reply("An error occurred during the game. Please try again.");
                }
            });
            this.bot.action(/thinking_mode_(.+)/, async (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                const mode = ctx.match[1];

                // Update user preferences
                // Implement preference storage mechanism

                await adapter.answerCallbackQuery(`Thinking display mode set to: ${mode}`);
            });

            this.bot.action('thinking_show_more', async (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                // Implement show more logic using cached thinking content
            });

            this.bot.action('thinking_hide', async (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                await ctx.deleteMessage();
            });

            // Register the action handler for RAG mode toggle
            this.bot.action(/^ragmode:/, (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                return this.handleRagModeToggle(adapter);
            });

            // Register handlers for bot selection and command execution
            this.bot.action(/^select_bot:/, (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                return this.handleBotSelection(adapter);
            });

            this.bot.action(/^execute_command:/, (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                return this.handleCommandExecution(adapter);
            });

            await this.bot.telegram.setMyCommands(botCommands);
            console.log('Bot commands set successfully');

            // Update ConversationManager with registered commands
            this.conversationManager.setCommands(commands);
            console.log('Commands registered in ConversationManager');

        } catch (error) {
            console.error('Error registering commands:', error);
            throw error;
        }
    }
    public async executeCommandByName(adapter: ContextAdapter, commandName: string): Promise<void> {
        const command = Object.values(commandModules).find(cmd => cmd.name === commandName);
        if (command) {
            await this.executeCommand(adapter, command);
        } else {
            await adapter.reply("Unknown command. Type /help for a list of available commands.");
        }
    }
    public createCommandMenus(): void {
        this.botInfo.forEach(bot => {
            const botCommands = Object.values(commandModules);
            const keyboard = Markup.inlineKeyboard(
                botCommands.map(cmd => [
                    Markup.button.callback(`/${cmd.name}`, `execute_command:${bot.id}:${cmd.name}`)
                ])
            );
            this.botCommandMenus.set(bot.id, keyboard);
        });
    }

    public async showCommandMenu(adapter: ContextAdapter, botId: number, page: number = 0): Promise<void> {
        console.log(`Showing command menu for bot ID: ${botId}, page: ${page}`);

        const bot = this.botInfo.find(b => b.id === botId);
        if (!bot) {
            console.warn(`[CommandHandler] Bot not found for ID: ${botId}`);
            if (adapter.isCallbackQuery()) {
                await adapter.answerCallbackQuery("Bot not found.");
            }
            return;
        }

        // Debug check for managers
        if (!this.conversationManager) {
            console.error('[CommandHandler] conversationManager is not initialized');
            return;
        }
        if (!this.menuManager) {
            console.error('[CommandHandler] menuManager is not initialized');
            return;
        }

        // Get and verify commands
        const commands = this.conversationManager.getCommands();
        console.log('[CommandHandler] Retrieved commands:', {
            commandsExist: !!commands,
            commandCount: commands?.length,
            commandList: commands?.map(c => c.name)
        });

        if (!commands || commands.length === 0) {
            console.warn('[CommandHandler] No commands available from ConversationManager');
            await adapter.reply("Commands are currently unavailable. Please try again later.");
            return;
        }

        // Create menu with verified commands
        const commandMenu = this.menuManager.createBotCommandMenu(botId, commands, page);

        const text = `Available commands for ${bot.firstName} (Page ${page + 1}):`;
        const extra: any = {
            reply_markup: commandMenu.reply_markup
        };

        try {
            let sentMessage;
            if (adapter.isCallbackQuery()) {
                sentMessage = await adapter.editMessageText(text, extra);
            } else {
                sentMessage = await adapter.reply(text, extra);
            }

            if (sentMessage && typeof sentMessage === 'object' && 'message_id' in sentMessage) {
                this.menuManager.setMenuTimeout(adapter, sentMessage.message_id, 60000);
            }
            console.log(`Command menu displayed for bot: ${bot.firstName}, page: ${page}`);
        } catch (error) {
            console.error('Error displaying command menu:', error);
            if (adapter.isCallbackQuery()) {
                await adapter.answerCallbackQuery("Unable to display command menu. Please try again.");
            } else {
                await adapter.reply("Unable to display command menu. Please try again.");
            }
        }
    }

    private async executeCommand(adapter: ContextAdapter, command: Command): Promise<void> {
        const methodName = 'executeCommand';
        console.log(`[${methodName}] Entering executeCommand`);

        if (!this.conversationManager) {
            await adapter.reply("Bot is not fully initialized. Please try again later.");
            return;
        }

        try {
            const { userId, sessionId } = await this.conversationManager.getSessionInfo(adapter.getMessageContext());
            if (this.telegramBot) {
                console.warn(`[${methodName}] Executing Command: ${command.name}`);

                // Update the Command interface to accept ContextAdapter instead of Context
                await command.execute(
                    adapter,
                    this.conversationManager,
                    this.memory,
                    userId,
                    sessionId,
                    this.promptManager,
                    this.telegramBot
                );
            } else {
                console.error(`TelegramBot instance is null for command: ${command.name}`);
                await adapter.reply("Unable to process command due to a configuration issue.");
            }
        } catch (error) {
            console.error(`Error executing command ${command.name}:`, error);
            await adapter.reply("An error occurred while processing your command. Please try again later.");
        }
    }

    private async handleBotSelection(adapter: ContextAdapter): Promise<void> {
        const context = adapter.getMessageContext();
        if (!context.callbackQuery || !context.callbackQuery.data) return;
        const botId = parseInt(context.callbackQuery.data.split(':')[1]);
        await this.showCommandMenu(adapter, botId);
    }

    private async handleCommandExecution(adapter: ContextAdapter): Promise<void> {
        const context = adapter.getMessageContext();
        if (!context.callbackQuery || !context.callbackQuery.data) return;
        const [, , commandName] = context.callbackQuery.data.split(':');
        await this.executeCommandByName(adapter, commandName);
    }


    public createCommandMenu(botId: number): void {
        const botCommands = Object.values(commandModules);
        const keyboard = Markup.inlineKeyboard(
            botCommands.map(cmd => [Markup.button.callback(`/${cmd.name}`, `execute_command:${botId}:${cmd.name}`)])
        );
        this.botCommandMenus.set(botId, keyboard);
    }



    async handleMessage(adapter: ContextAdapter, input?: string, interactionType?: InteractionType, replyToMessage?: { message_id: number; text: string },
    ): Promise<void> {
        console.log("[CommandHandler]Entering handleMessage");
        if (!this.conversationManager || !this.memory) {
            await adapter.reply("Bot is not fully initialized. Please try again later.");
            return;
        }

        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.conversationManager.getSessionInfo(context);

        // If input is not provided, try to get it from the message
        if (!input) {
            if (!context.raw.message || !('text' in context.raw.message)) {
                await adapter.reply("I can only process text messages.");
                return;
            }
            input = context.raw.message.text;
        }

        // Ensure input is not undefined
        if (input === undefined) {
            await adapter.reply("I couldn't understand your message. Please try again.");
            return;
        }

        const chatHistoryResult = await this.memory.getChatMessagesExtended(userId, sessionId);
        const chatHistory: BaseMessage[] = this.convertToChatHistory(chatHistoryResult);

        // Always process the input to get the enhancedResponse
        const enhancedResponse = await this.conversationManager.processWithRAGAgent(input, chatHistory, interactionType!, userId, adapter, replyToMessage);

        // Send the main response
        await adapter.reply(enhancedResponse.response.join('\n'));

        // Handle source citations
        if (enhancedResponse.sourceCitations && enhancedResponse.sourceCitations.length > 0) {
            const citationsText = enhancedResponse.sourceCitations.map((citation: SourceCitation) =>
                `📚 ${citation.text} (Source: ${citation.source})`
            ).join('\n\n');
            await adapter.reply(`Sources:\n${citationsText}`);
        }

        // Handle follow-up questions
        if (enhancedResponse.followUpQuestions && enhancedResponse.followUpQuestions.length > 0) {
            const keyboard = Markup.inlineKeyboard(
                enhancedResponse.followUpQuestions.map((question: string) =>
                    [Markup.button.callback(`🔍 ${question}`, `follow_up:${question}`)]
                )
            );
            await adapter.reply('🤔 Would you like to explore any of these follow-up questions?', {
                reply_markup: keyboard.reply_markup
            });
        }

        // Handle external agent suggestion
        if (enhancedResponse.externalAgentSuggestion) {
            await adapter.reply(`🤖 An external agent might be able to assist further: ${enhancedResponse.externalAgentSuggestion}`);
        }

        // Update memory
        if (this.telegramBot && 'updateMemory' in this.telegramBot) {
            await this.telegramBot.updateMemory(adapter, [
                new HumanMessage(input),
                new AIMessage(enhancedResponse.response.join('\n'))
            ]);
        }
    }

    private convertToChatHistory(chatHistoryResult: any[]): BaseMessage[] {
        return chatHistoryResult.map(msg => {
            if (this.isExtendedIMessage(msg)) {
                const content = this.getMessageContent(msg);
                if (msg.type === 'userMessage') {
                    return new HumanMessage(content);
                } else if (msg.type === 'apiMessage') {
                    return new AIMessage(content);
                } else {
                    return new SystemMessage(content);
                }
            } else if (msg instanceof BaseMessage) {
                return msg;
            } else {
                return new SystemMessage('Unknown message type');
            }
        });
    }



    getCommandList(): string {
        return Object.values(commandModules)
            .map(cmd => `/${cmd.name} - ${cmd.description}`)
            .join('\n');
    }

    private isValidCommand(command: any): command is Command {
        return command &&
            typeof command.name === 'string' &&
            typeof command.description === 'string' &&
            typeof command.execute === 'function';
    }
    private async handleRagModeToggle(adapter: ContextAdapter): Promise<void> {
        try {
            const context = adapter.getMessageContext();
            if (!context.callbackQuery || !('data' in context.callbackQuery)) {
                console.error('Invalid callback query');
                await adapter.answerCallbackQuery('Invalid request. Please try again.');
                return;
            }

            const botId = context.callbackQuery.data.split(':')[1];
            const chatId = context.chatId;

            if (!chatId) {
                console.error('Chat ID is undefined');
                await adapter.answerCallbackQuery('Unable to process request. Chat information is missing.');
                return;
            }

            if (!this.telegramBot) {
                console.error('TelegramBot instance is not available');
                await adapter.answerCallbackQuery('Bot is not fully initialized. Please try again later.');
                return;
            }

            const botInfo = this.telegramBot.getAllBotInfo().find(bot => bot.id.toString() === botId);
            if (!botInfo) {
                await adapter.answerCallbackQuery('Selected bot not found.');
                return;
            }

            if (this.agentManager) {
                const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
                if (ragAgent && 'isRAGModeEnabled' in ragAgent && 'toggleRAGMode' in ragAgent) {
                    const currentStatus = ragAgent.isRAGModeEnabled(botId);
                    ragAgent.toggleRAGMode(botId, !currentStatus);
                    const newStatus = !currentStatus;

                    await adapter.answerCallbackQuery(`RAG mode ${newStatus ? 'enabled' : 'disabled'} for @${botInfo.username || botInfo.firstName}`);
                    await adapter.editMessageText(`RAG mode ${newStatus ? 'enabled' : 'disabled'} for @${botInfo.username || botInfo.firstName}`);
                } else {
                    await adapter.answerCallbackQuery('Unable to toggle RAG mode. RAG Agent not properly configured.');
                }
            } else {
                await adapter.answerCallbackQuery('Unable to toggle RAG mode. AgentManager not initialized.');
            }
        } catch (error) {
            console.error('Error in handleRagModeToggle:', error);
            await adapter.answerCallbackQuery('An error occurred while processing your request. Please try again later.');
        }
    }

    private isExtendedIMessage(msg: any): msg is ExtendedIMessage {
        return (
            typeof msg === 'object' &&
            msg !== null &&
            'type' in msg &&
            ('text' in msg || 'message' in msg)
        );
    }

    private getMessageContent(msg: ExtendedIMessage): string {
        const content = msg.text || msg.message;
        if (typeof content === 'string') {
            return content;
        } else if (Array.isArray(content)) {
            return content.map(item => this.stringifyContent(item)).join(' ');
        } else if (content && typeof content === 'object') {
            return this.stringifyContent(content);
        } else {
            return '';
        }
    }

    private stringifyContent(item: any): string {
        if (typeof item === 'string') {
            return item;
        } else if (typeof item === 'object' && item !== null) {
            if ('text' in item) {
                return item.text;
            } else if ('image_url' in item) {
                return `[Image: ${item.image_url.url}]`;
            } else {
                return JSON.stringify(item);
            }
        } else {
            return String(item);
        }
    }

    private isRAGAgent(agent: any): agent is RAGAgent {
        return (
            typeof agent === 'object' &&
            agent !== null &&
            'isRAGModeEnabled' in agent &&
            'toggleRAGMode' in agent &&
            typeof agent.isRAGModeEnabled === 'function' &&
            typeof agent.toggleRAGMode === 'function'
        );
    }



    // In CommandHandler.ts
    public async handleMillionaireCommand(adapter: ContextAdapter, command: string, _userId: string) {
        const methodName = 'handleMillionaireCommand';
        const context = adapter.getMessageContext();
        try {
            const [action, parameter] = command.split(':');
            // Try to answer the callback query but don't let it stop execution
            await adapter.answerCallbackQuery(`Action Received: "${parameter}", processing....`);
        } catch (callbackError) {
            // If this fails (due to double-click or timeout), just log and continue
            if (callbackError.response?.description?.includes('query is too old') ||
                callbackError.response?.description?.includes('query ID is invalid')) {
                console.log(`[${methodName}] Callback already answered or expired:`, callbackError.response.description);
                // Continue execution - don't return
            } else {
                // For other unexpected callback errors, log but continue
                console.warn(`[${methodName}] Unexpected callback error:`, callbackError);
            }
        }
        const { userId, sessionId } = await this.conversationManager!.getSessionInfo(adapter);
        const chatId = context.chatId;
        console.log(`[${methodName}] Processing command:`, {
            originalUserId: userId,
            userId,
            command,
            timestamp: new Date().toISOString()
        });

        const gameAgent = this.agentManager?.getAgent('game') as GameAgent;
        if (!gameAgent) {
            console.error(`[${methodName}] Game agent not available`);
            await adapter.replyWithAutoDelete("Game system is not available. Please try again later.", 30000);
            return;
        }

        try {
            const [action, parameter] = command.split(':');
            const gameState = gameAgent.getGameState(userId);

            if (!gameState?.isActive) {
                throw new Error('No active game');
            }

            switch (action) {
                case 'answer':
                    if (!gameState.currentQuestion || !gameState.lastMessageId) {
                        throw new Error('No active question');
                    }
                    console.log(`[${methodName}, Received answer: "${parameter}"`);
                    const numericAnswer = this.convertAnswerToIndex(parameter);
                    if (numericAnswer === -1) {
                        await adapter.replyWithAutoDelete("[handleMillionaireCommand] Invalid answer received. Please try again.", 30000);
                        return;
                    }
                    if (!gameAgent['isSessionOwner'](userId, chatId)) {
                        await this.safeAnswerCallback(adapter, 'Only the player who started the game can interact with it');
                        return;
                    }
                    // Submit answer will handle message editing internally
                    const result = await gameAgent.submitAnswer(adapter, userId, numericAnswer);

                    if (result.correct && gameState.lastMessageId) {
                        // Progress to next question will handle message editing internally
                        const nextResponse = await gameAgent.progressToNextQuestion(adapter, userId);
                        // No need to send new message, the GameAgent will handle editing the existing one
                    }
                    break;

                case 'lifeline':
                    if (!gameState.currentQuestion || !gameState.lastMessageId) {
                        throw new Error('No active question');
                    }
                    if (!gameAgent['isSessionOwner'](userId, chatId)) {
                        await this.safeAnswerCallback(adapter, 'Only the player who started the game can interact with it');
                        return;
                    }

                    let lifelineType: LifelineType;
                    switch (parameter) {
                        case '5050':
                            lifelineType = 'fiftyFifty';
                            break;
                        case 'phone':
                            lifelineType = 'phoneAFriend';
                            break;
                        case 'audience':
                            lifelineType = 'askTheAudience';
                            break;
                        default:
                            throw new Error(`Invalid lifeline type: ${parameter}`);
                    }

                    console.log(`[${methodName}] Using lifeline:`, {
                        userId: userId,
                        lifelineType,
                        questionId: gameState.currentQuestion?.question,
                        messageId: gameState.lastMessageId
                    });

                    // useLifeline will handle message editing internally
                    if (gameState.lastMessageId) {
                        await gameAgent.useLifeline(adapter, userId, lifelineType);
                    }
                    break;

                case 'new':
                    if (gameState.isActive) {
                        await adapter.replyWithAutoDelete("[handleMillionaireCommand] Game already in session!", 30000);
                        return;
                    }
                    await adapter.reply("/millionaire");
                    break;

                case 'quit':
                    await gameAgent.exitGame(adapter, userId, 'user_exit');
                    break;

                default:
                    await adapter.replyWithAutoDelete("Invalid game command. Please try again.", 30000);
                    break;
            }
        } catch (error) {
            console.error(`[${methodName}] Error:`, error);
            const errorMessage = error.message === 'No active game' ?
                "No active game found. Use /millionaire to start a new game." :
                error.message === 'No active question' ?
                    "No active question. Use /millionaire to start a new game." :
                    "An error occurred during the game. Please try again.";

            await adapter.replyWithAutoDelete(errorMessage, 30000);
        }
    }

    private convertAnswerToIndex(answer: string): number {
        console.warn(`[CommandHandler, convertAnswerToIndex] Received answer: "${answer}"`);

        const answerMap: { [key: string]: number } = {
            'A': 0,
            'B': 1,
            'C': 2,
            'D': 3
        };

        const index = answerMap[answer] ?? -1;

        if (index === -1) {
            console.warn(`[convertAnswerToIndex] Unexpected answer value: "${answer}". Returning -1.`);
        } else {
            console.log(`[convertAnswerToIndex] Mapped answer "${answer}" to index: ${index}`);
        }

        return index;
    }
    public async handleThinkingCallback(adapter: ContextAdapter, data: string): Promise<void> {
        const context = adapter.getMessageContext();
        const messageId = context.messageId?.toString();

        if (!messageId) {
            await this.safeAnswerCallback(adapter, 'Message ID not available');
            return;
        }

        try {
            if (!this.conversationManager) {
                await this.safeAnswerCallback(adapter, 'System not ready');
                return;
            }

            const thinkingManager = this.conversationManager.getThinkingManager();
            if (!thinkingManager) {
                await this.safeAnswerCallback(adapter, 'Thinking system not available');
                return;
            }

            if (data === 'thinking_toggle') {
                await thinkingManager.handleThinkingToggle(adapter, messageId);
            } else if (data.startsWith('thinking_mode_')) {
                const mode = data.replace('thinking_mode_', '') as ThinkingDisplayMode;
                await this.updateThinkingPreferences(adapter, mode);
            } else {
                await this.safeAnswerCallback(adapter, 'Unknown thinking action');
            }
        } catch (error) {
            console.error('Error in handleThinkingCallback:', error);
            await this.safeAnswerCallback(adapter, 'Error processing thinking action');
        }
    }


    private async safeAnswerCallback(adapter: ContextAdapter, text: string): Promise<void> {
        try {
            await adapter.answerCallbackQuery(text);
        } catch (error) {
            // If the callback query is expired, try to send a regular message instead
            if (error.response?.description?.includes('query is too old') ||
                error.response?.description?.includes('query ID is invalid')) {
                try {
                    // Send a temporary message instead
                    await adapter.replyWithAutoDelete(text, 5000);
                } catch (msgError) {
                    console.warn('Failed to send fallback message:', msgError);
                }
            } else {
                console.warn('Failed to answer callback:', error);
            }
        }
    }


    private async updateThinkingPreferences(adapter: ContextAdapter, mode: ThinkingDisplayMode): Promise<void> {
        const context = adapter.getMessageContext();
        const userId = context.userId.toString();

        if (!this.conversationManager) {
            await this.safeAnswerCallback(adapter, 'System not ready');
            return;
        }

        const thinkingManager = this.conversationManager.getThinkingManager();
        if (!thinkingManager) {
            await this.safeAnswerCallback(adapter, 'Thinking system not available');
            return;
        }

        // Update preferences in ThinkingManager
        await thinkingManager.updatePreferences(userId, {
            displayMode: mode,
            showThinking: mode !== ThinkingDisplayMode.HIDDEN,
            thinkingDuration: 12 * 60 * 60 * 1000, // 12 hours
            format: 'detailed',
            autoDelete: mode !== ThinkingDisplayMode.DEBUG_ONLY
        });

        await adapter.reply(`Thinking display mode updated to: ${mode}`);
    }


    public setupThinkingHandlers(): void {
        this.bot.action(/thinking_toggle/, async (ctx) => {
            const adapter = new ContextAdapter(ctx, this.promptManager);
            await this.handleThinkingCallback(adapter, 'thinking_toggle');
        });

        this.bot.action(/thinking_mode_(.+)/, async (ctx) => {
            const adapter = new ContextAdapter(ctx, this.promptManager);
            const mode = ctx.match[1];
            await this.handleThinkingCallback(adapter, `thinking_mode_${mode}`);
        });
    }



    private truncateDescription(description: string, maxLength: number = 30): string {
        return description.length > maxLength
            ? description.substring(0, maxLength) + '...'
            : description;
    }

    // In CommandHandler class
    public async processWithoutPattern(
        adapter: ContextAdapter,
        cachedContext: PatternContextData
    ): Promise<void> {
        const methodName = 'processWithoutPattern';
        console.log(`[${methodName}] Starting normal processing for skipped pattern`);

        if (!this.conversationManager) {
            console.error(`[${methodName}] ConversationManager not initialized`);
            await adapter.reply("System is not fully initialized.");
            return;
        }

        try {
            console.log(`[${methodName}] Calling generateResponse with disablePatternSuggestion flag`);

            const response = await this.conversationManager.generateResponse(
                cachedContext.input,
                cachedContext.chatHistory || [],
                cachedContext.metadata?.isReply || false,
                adapter.getMessageContext().userId.toString(),
                adapter,
                cachedContext.metadata?.replyToMessage,
                undefined,         // progressKey
                undefined,         // thinkingPreferences
                true               // disablePatternSuggestion
            );

            console.log(`[${methodName}] Received ${response.length} response chunks`);

            // Send each response chunk
            for (const chunk of response) {
                await adapter.reply(chunk);
            }

            console.log(`[${methodName}] Completed normal processing after pattern skip`);
        } catch (error) {
            console.error(`[${methodName}] Error:`, error);
            await adapter.reply("Sorry, there was an error processing your request normally.");
        }
    }


    public async handlePatternAction(
        adapter: ContextAdapter,
        action: string,
        parameter?: string
    ): Promise<void> {
        const methodName = 'handlePatternAction';
        try {
            const { userId, sessionId } = await this.conversationManager!.getSessionInfo(adapter);

            // Get user ID for context cache lookup
            const callbackUserId = adapter.context.raw?.callbackQuery?.from?.id || userId;
            console.log(`[${methodName}] Looking for pattern context with user ID: ${callbackUserId}, fallback ID: ${userId}`);

            // Try both user IDs when looking up context data
            let contextData = this.conversationManager?.cache.get<PatternContextData>(`pattern_context:${userId}`);
            if (!contextData && userId !== callbackUserId) {
                contextData = this.conversationManager?.cache.get<PatternContextData>(`pattern_context:${callbackUserId}`);
            }

            if (!contextData) {
                await adapter.answerCallbackQuery('Pattern context not found. Please try again.');
                return;
            }

            // Get or initialize pattern data
            let patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
            if (!patternData) {
                patternData = {
                    originalInput: '',
                    processedOutputs: {},
                    currentPatternState: {}
                };
            }

            if (contextData?.input) {
                // Store the input in patternData for consistent access
                this.storePatternInput(userId, contextData.input);
                patternData.originalInput = contextData.input;
                console.log(`[${methodName}] Stored original input in pattern data, length: ${contextData.input.length}`);
            }
            const agentManager = this.conversationManager!.getAgentManager();
            if (!agentManager) {
                throw new Error('AgentManager not available');
            }

            const patternAgent = agentManager.getAgent('pattern') as PatternPromptAgent;
            if (!patternAgent) {
                throw new Error('Pattern agent not available');
            }

            // Get the message ID of the menu message (from callback query or context data)
            const menuMessageId = contextData.originalMessageId || adapter.context.messageId;

            // For pattern processing, we'll still need the original content
            const contentToProcess = contextData?.input || '';
            let useProcessedContent = false;

            // If we're applying a pattern, we might want to use already processed content
            if (action === 'use') {
                useProcessedContent = true;
            }

            // Get the appropriate content based on the action
            const contentToUse = this.getContentForProcessing(adapter, userId, '', useProcessedContent);

            console.log(`[${methodName}] Content to use for ${action} (first 50 chars): ${contentToUse?.substring(0, 50) || 'none'}...`);

            if (action === 'use' && parameter) {
                await this.handlePatternUse(adapter, patternAgent, userId, parameter, contentToUse);
            }
            else if (action === 'more') {
                const patternAgent = agentManager.getAgent('pattern') as PatternPromptAgent;
                const categories = patternAgent.getCategories();
                const keyboard = this.menuManager!.createPatternCategoriesMenu(categories).reply_markup;

                await adapter.editMessageText(
                    '📋 <b>Select a Pattern Category</b>\n\nChoose a category to see available processing patterns:',
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            }
            else if (action === 'category' && parameter) {
                await this.showCategoryPatterns(adapter, patternAgent, parameter, menuMessageId);
            }
            else if (action === 'back_to_menu') {
                await this.showOriginalPatternMenu(adapter, userId, menuMessageId);
            }
            else if (action === 'categories') {
                const isAlreadyOnCategories = adapter.context.raw?.callbackQuery?.message?.text?.includes("Select a Pattern Category");

                if (!isAlreadyOnCategories) {
                    await this.showPatternCategories(adapter, patternAgent, menuMessageId);
                } else {
                    await adapter.safeAnswerCallbackQuery("Already showing categories");
                }
            }
            else if (action === 'back') {
                await this.showPatternCategories(adapter, patternAgent, menuMessageId);
            }
            else if (action === 'skip') {
                await this.handlePatternSkip(adapter, userId);
            }
            else if (action === 'next_page' && parameter) {
                const [category, pageStr] = parameter.split(':');
                const page = parseInt(pageStr) || 0;
                await this.showCategoryPatterns(adapter, patternAgent, category, menuMessageId, page + 1);
            }
            else if (action === 'prev_page' && parameter) {
                const [category, pageStr] = parameter.split(':');
                const page = parseInt(pageStr) || 0;
                if (page > 0) {
                    await this.showCategoryPatterns(adapter, patternAgent, category, menuMessageId, page - 1);
                }
            }
            else if (action === 'view_batch' && parameter) {
                const [batchKey, indexStr] = parameter.split(':');
                const index = parseInt(indexStr) || 0;
                await this.viewBatchResult(adapter, userId, batchKey, index);
            }
            else if (action === 'chunk' && parameter) {
                const [patternName, direction] = parameter.split(':');
                await this.navigateResultChunks(adapter, userId, patternName, direction);
            }
            else if (action === 'browse_input') {
                await this.navigateInputChunks(adapter, userId, 'first');
            }
            else if (action === 'input_chunk') {
                await this.navigateInputChunks(adapter, userId, parameter || 'next');
            }
            else if (action === 'select_chunk') {
                const chunkIndex = parseInt(parameter || '0');
                patternData.currentPatternState.selectedInputChunk = chunkIndex;
                this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 7200);
                await this.showOriginalPatternMenu(adapter, userId, menuMessageId, '', true);  // Pass empty string for content and true for useSelectedChunk
            }
            else if (action === 'select_all_chunks') {
                await this.showPatternMenuForAllChunks(adapter, userId, menuMessageId);
            }
            else if (action === 'process_all' && parameter) {
                const patternName = parameter;
                await this.processAllChunks(adapter, userId, patternName);
            }
            else if (action === 'apply_to_chunk') {
                const [sourceName, chunkIndexStr] = parameter?.split(':') || ['', '0'];
                const chunkIndex = parseInt(chunkIndexStr);
                const sourceData = patternData.processedOutputs[sourceName];

                if (sourceData?.chunks && sourceData.chunks.length > chunkIndex) {
                    // Show pattern menu but with the selected chunk as source
                    await this.showPatternMenuForChunk(adapter, userId, sourceName, chunkIndex, menuMessageId);
                } else {
                    await adapter.answerCallbackQuery('Selected chunk not available');
                }
            }
            else if (action === 'choose_output') {
                await this.showProcessedOutputsMenu(adapter, userId, menuMessageId);
            }
            else if (action === 'advanced') {
                await this.showAdvancedPatternMenu(adapter, userId, menuMessageId);
            }
            else if (action === 'select_output') {
                // Set the selected output as the source for the next pattern
                const outputName = parameter || '';

                if (patternData.processedOutputs && patternData.processedOutputs[outputName]) {
                    // If the output has chunks, show navigation
                    if (patternData.processedOutputs[outputName].chunks &&
                        patternData.processedOutputs[outputName].chunks!.length > 1) {
                        await this.navigateResultChunks(adapter, userId, outputName, 'first');
                    } else {
                        // Set this output as the source and show pattern menu
                        patternData.currentPatternState.useProcessedOutput = outputName;
                        this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 7200);
                        await this.showOriginalPatternMenu(adapter, userId, menuMessageId);
                    }
                } else {
                    await adapter.answerCallbackQuery('Selected output not found');
                }
            }
            else if (action === 'use_full_input') {
                // Clear any previous selection and show pattern menu
                if (patternData) {
                    delete patternData.currentPatternState.useProcessedOutput;
                    delete patternData.currentPatternState.selectedInputChunk;
                    this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 3600);
                }
                await this.showOriginalPatternMenu(adapter, userId, menuMessageId);
            }
            else {
                console.warn(`[${methodName}] Unknown pattern action:`, action);
                await adapter.answerCallbackQuery('Unknown pattern action');
            }

        } catch (error) {
            console.error('Error handling pattern callback:', error);
            let errorMessage = "An error occurred processing your pattern selection.";
            if (error instanceof Error) {
                errorMessage = error.message;
            }
            await adapter.answerCallbackQuery(errorMessage);
        }
    }

    private async handlePatternUse(
        adapter: ContextAdapter,
        patternAgent: PatternPromptAgent,
        userId: string,
        patternName: string,
        contentToUse?: string
    ): Promise<void> {
        const methodName = 'handlePatternUse';
        console.log(`[${methodName}] Processing pattern use:`, patternName);

        // Get pattern data from cache
        const patternDataKey = `pattern_data:${userId}`;
        let patternData = this.conversationManager!.cache.get<PatternData>(patternDataKey);

        // If no pattern data, check for context data
        const contextDataKey = `pattern_context:${userId}`;
        const contextData = this.conversationManager!.cache.get<PatternContextData>(contextDataKey);

        if (!patternData && contextData?.input) {
            // Initialize pattern data from context data
            patternData = {
                originalInput: contextData.input,
                processedOutputs: {},
                currentPatternState: {}
            };
            this.conversationManager!.cache.set(patternDataKey, patternData, 7200);
        }

        if (!patternData) {
            await adapter.answerCallbackQuery('Pattern data not available. Please try again.');
            return;
        }

        // Determine the input to use for processing
        // ADD THE CODE HERE - Determine the input to use for processing
        let input: string;
        if (patternData.currentPatternState.useProcessedOutput) {
            // Use previously processed output if specified
            const sourceName = patternData.currentPatternState.useProcessedOutput;
            const sourceOutput = patternData.processedOutputs[sourceName]?.output;

            if (sourceOutput) {
                input = sourceOutput;
                console.log(`[${methodName}] Using processed output from ${sourceName} as input`);
            } else {
                input = patternData.originalInput;
                console.log(`[${methodName}] Source output not found, using original input`);
            }
        } else {
            // Use original input
            input = patternData.originalInput;
            console.log(`[${methodName}] Using original input`);
        }

        await adapter.safeAnswerCallbackQuery(`Processing with ${patternName} pattern...`);

        // Show processing status in menu
        const menuMessageId = adapter.context.messageId;
        if (menuMessageId) {
            try {
                await adapter.editMessageText(
                    `🔄 Processing with ${patternName} pattern...\n\nThis may take a moment.`,
                    { parse_mode: 'HTML' }
                );
            } catch (error) {
                console.warn(`[${methodName}] Error updating menu message:`, error);
            }
        }

        try {
            // Process the entire input in one go
            // For extremely large inputs (over model context limit), we'd need to handle differently
            let result: string;

            if (input.length > 100000) {  // Arbitrary threshold for extremely large inputs
                await adapter.editMessageText(
                    `⚠️ This content is extremely large (${Math.round(input.length / 1000)}K characters).\n\nProcessing in chunks...`,
                    { parse_mode: 'HTML' }
                );

                // For extremely large content, we still need to process in chunks
                const inputChunks = this.splitInput(input);
                console.log(`[${methodName}] Processing large input in ${inputChunks.length} chunks`);

                // Process each chunk and combine results
                const chunkResults: string[] = [];
                for (let i = 0; i < inputChunks.length; i++) {
                    // Update progress
                    if (menuMessageId) {
                        try {
                            await adapter.editMessageText(
                                `🔄 Processing with ${patternName} pattern...\n\nProcessing chunk ${i + 1}/${inputChunks.length}`,
                                { parse_mode: 'HTML' }
                            );
                        } catch (error) {
                            console.warn(`[${methodName}] Error updating chunk progress:`, error);
                        }
                    }

                    // Process this chunk
                    const chunkResult = await patternAgent.processWithPattern(
                        patternName,
                        inputChunks[i],
                        adapter
                    );
                    chunkResults.push(chunkResult);
                }

                // Combine results
                result = this.combineChunkResults(patternName, chunkResults);
            } else {
                // Normal processing for reasonable sized inputs
                result = await patternAgent.processWithPattern(patternName, input, adapter);
            }

            // Store the result
            if (!patternData.processedOutputs) {
                patternData.processedOutputs = {};
            }

            patternData.processedOutputs[patternName] = {
                output: result,
                timestamp: Date.now()
            };

            // Show output actions menu using helper method
            await this.showOutputActionsMenu(adapter, result, adapter.context.messageId ? adapter.context.messageId.toString() : '', 'HTML');

            // For display purposes, check if we need to split the output for Telegram
            // For single messages
            if (result.length <= 4000) {
                // Send as single message with HTML parsing
                // const htmlResult = this.convertMarkdownToHtml(result); // Convert if result is in Markdown format
                const sentMessage = await adapter.reply(result, { parse_mode: 'HTML' });

                // Store the message ID if available
                if (sentMessage && 'message_id' in sentMessage) {
                    patternData.processedOutputs[patternName].messageIds = [sentMessage.message_id];

                    // Add menu to this single message by editing it
                    const buttons = [];

                    // Action buttons for the processed content
                    buttons.push([
                        Markup.button.callback('📋 Apply Another Pattern', 'pattern_back_to_menu'),
                        Markup.button.callback('📥 Download Result', `pattern_download:${patternName}`)
                    ]);

                    // Add this button to return to original input
                    buttons.push([
                        Markup.button.callback('🔄 Use Original Input', 'pattern_use_full_input')
                    ]);

                    // Navigation buttons
                    buttons.push([
                        Markup.button.callback('📊 More Patterns', 'pattern_more'),
                        Markup.button.callback('🔧 Advanced Options', 'pattern_advanced'),
                        Markup.button.callback('✅ Done', 'pattern_skip')
                    ]);

                    const keyboard = Markup.inlineKeyboard(buttons);

                    try {
                        await adapter.editMessageText(
                            `${result}\n\n-----\n📝 <b>Result processed with ${patternName}</b>`,
                            {
                                parse_mode: 'HTML',
                                reply_markup: keyboard.reply_markup
                            }
                        );
                    } catch (error) {
                        console.warn(`[${methodName}] Error adding menu to result message:`, error);

                        // Fallback: send a separate menu message
                        await adapter.reply(
                            `📝 <b>Result processed with ${patternName}</b>`,
                            {
                                parse_mode: 'HTML',
                                reply_markup: keyboard.reply_markup
                            }
                        );
                    }
                }
            } else {
                // Split output for display and send in chunks
                const outputChunks = this.splitOutput(result);
                patternData.processedOutputs[patternName].chunks = outputChunks;

                const messageIds: number[] = [];

                // Send each output chunk
                for (let i = 0; i < outputChunks.length; i++) {
                    const isLastChunk = i === outputChunks.length - 1;
                    const chunkText = outputChunks[i] + (isLastChunk ? '' : '\n[continued in next message...]');

                    // For the last chunk, include buttons
                    const sentMessage = await adapter.reply(
                        chunkText,
                        { parse_mode: 'Markdown' }
                    );

                    // Store message ID if available
                    if (sentMessage && 'message_id' in sentMessage) {
                        messageIds.push(sentMessage.message_id);

                        // If this is the last chunk, add menu buttons
                        if (isLastChunk) {
                            const buttons = [];

                            // Add navigation controls for multi-chunk results
                            buttons.push([
                                Markup.button.callback('⬅️ Previous Chunk', `pattern_chunk:${patternName}:prev`),
                                Markup.button.callback(`${i + 1}/${outputChunks.length}`, 'pattern_noop'),
                                Markup.button.callback('Next Chunk ➡️', `pattern_chunk:${patternName}:next`)
                            ]);

                            // Action buttons
                            buttons.push([
                                Markup.button.callback('📋 Apply Another Pattern', 'pattern_back_to_menu'),
                                Markup.button.callback('📥 Download', `pattern_download:${patternName}`),
                            ]);

                            buttons.push([
                                Markup.button.callback('🔍 Browse Input Chunks', 'pattern_browse_input'),
                            ]);

                            const keyboard = Markup.inlineKeyboard(buttons);

                            try {
                                // Use the correct parameter structure for editMessageText
                                await adapter.editMessageText(
                                    `${chunkText}\n\n-----\n📝 <b>Part ${i + 1} of ${outputChunks.length}</b>`,
                                    {
                                        parse_mode: 'HTML',
                                        reply_markup: keyboard.reply_markup
                                    }
                                );
                            } catch (error) {
                                console.warn(`[${methodName}] Error adding menu to final chunk:`, error);
                            }
                        }
                    }

                    // Short delay to maintain order
                    if (!isLastChunk) {
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                }

                // Store all message IDs
                if (messageIds.length > 0) {
                    patternData.processedOutputs[patternName].messageIds = messageIds;

                    // Create navigation buttons
                    const buttons = [];

                    // Add navigation controls for multi-chunk results
                    buttons.push([
                        Markup.button.callback('⬅️ First Chunk', `pattern_chunk:${patternName}:first`),
                        Markup.button.callback(`1/${outputChunks.length}`, 'pattern_noop'),
                        Markup.button.callback('Last Chunk ➡️', `pattern_chunk:${patternName}:last`)
                    ]);

                    // Action buttons
                    buttons.push([
                        Markup.button.callback('📋 Apply Another Pattern', 'pattern_back_to_menu'),
                        Markup.button.callback('📥 Download', `pattern_download:${patternName}`)
                    ]);

                    const keyboard = Markup.inlineKeyboard(buttons);

                    // Send a separate menu message
                    await adapter.reply(
                        `📝 <b>Result processed with ${patternName}</b> (${outputChunks.length} parts)`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: keyboard.reply_markup
                        }
                    );
                }
            }

            // Update pattern data in cache
            this.conversationManager!.cache.set(patternDataKey, patternData, 7200);
            this.storePatternOutput(userId, patternName, result);
            // Remove the separate calls to addInteractiveControls and showOutputActionsMenu
            // since we're now adding menus directly to the result messages            
            /*
                        // Add interactive controls for multi-chunk results
                        if (patternData.processedOutputs[patternName]?.chunks &&
                            patternData.processedOutputs[patternName].chunks!.length > 1 &&
                            patternData.processedOutputs[patternName]?.messageIds &&
                            patternData.processedOutputs[patternName].messageIds!.length > 0) {
                            await this.addInteractiveControls(adapter, userId, patternName);
                        } else {
                            // For single messages, just show the output actions menu
                            await this.showOutputActionsMenu(adapter, userId, patternName, menuMessageId);
                        }
            */
        } catch (error) {
            console.error(`[${methodName}] Error:`, error);

            // Show error in menu
            if (menuMessageId) {
                try {
                    await adapter.editMessageText(
                        `❌ <b>Error processing with ${patternName} pattern</b>\n\nPlease try another pattern:`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: Markup.inlineKeyboard([
                                [Markup.button.callback('Try Another Pattern', 'pattern_back_to_menu')],
                                [Markup.button.callback('Cancel', 'pattern_skip')]
                            ]).reply_markup
                        }
                    );
                } catch (editError) {
                    console.warn(`[${methodName}] Error updating menu:`, editError);
                }
            }

            await adapter.reply(`Sorry, there was an error processing your request with the ${patternName} pattern: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    // Helper method to split large inputs into manageable chunks
    private splitInput(input: string): string[] {
        const chunks: string[] = [];
        const maxChunkSize = 3800;  // Slightly less than 4000 to allow for some overhead

        // If input is small enough, return as is
        if (input.length <= maxChunkSize) {
            return [input];
        }

        let remaining = input;
        while (remaining.length > 0) {
            let chunkSize = Math.min(maxChunkSize, remaining.length);

            // Try to find a good breakpoint
            if (chunkSize < remaining.length) {
                // Look for paragraph breaks (preferred)
                const paragraphBreak = remaining.lastIndexOf('\n\n', chunkSize);
                if (paragraphBreak > chunkSize - 500) {
                    chunkSize = paragraphBreak + 2;
                } else {
                    // Look for sentence breaks
                    const sentenceBreak = remaining.lastIndexOf('. ', chunkSize);
                    if (sentenceBreak > chunkSize - 200) {
                        chunkSize = sentenceBreak + 2;
                    } else {
                        // Fallback to word breaks
                        const wordBreak = remaining.lastIndexOf(' ', chunkSize);
                        if (wordBreak > chunkSize - 50) {
                            chunkSize = wordBreak + 1;
                        }
                    }
                }
            }

            // Add context to help with processing
            let chunk = remaining.substring(0, chunkSize);
            if (chunks.length > 0) {
                chunk = `[CONTINUATION - PART ${chunks.length + 1}]\n\n${chunk}`;
            }
            if (chunkSize < remaining.length) {
                chunk += `\n\n[TO BE CONTINUED]`;
            }

            chunks.push(chunk);
            remaining = remaining.substring(chunkSize);
        }

        return chunks;
    }

    // Helper method to intelligently combine multiple chunk results
    private combineChunkResults(patternName: string, chunkResults: string[]): string {
        if (chunkResults.length === 1) {
            return chunkResults[0];
        }

        // Different combining strategies based on pattern type
        switch (patternName) {
            case 'summarize':
                // For summarize, we might want to create a meta-summary
                return this.combineSummaries(chunkResults);

            case 'extract_wisdom':
            case 'extract_insights':
                // For extraction patterns, concatenate with section headers
                return this.combineExtractions(chunkResults);

            case 'analyze_prose':
            case 'analyze_paper':
                // For analysis patterns, combine with section headers and synthesis
                return this.combineAnalyses(chunkResults);

            default:
                // Default combination with section breaks
                return chunkResults.map((result, index) =>
                    `## Part ${index + 1}\n\n${result}`
                ).join('\n\n---\n\n');
        }
    }

    // Specialized combiners for different pattern types
    private combineSummaries(summaries: string[]): string {
        // If there are only a few summaries, just join them
        if (summaries.length <= 3) {
            return summaries.join('\n\n---\n\n');
        }

        // For many chunks, create a meta-summary with key points from each
        const combinedSummary = `# Combined Summary\n\n`;

        // Extract key points from each summary
        const keyPoints = summaries.map((summary, index) => {
            // Split into paragraphs and take first one as main point
            const paragraphs = summary.split('\n\n');
            return `## Key Points from Part ${index + 1}:\n\n${paragraphs[0]}\n`;
        }).join('\n\n');

        return combinedSummary + keyPoints;
    }

    private combineExtractions(extractions: string[]): string {
        // Join extractions with clear section headers
        return extractions.map((extraction, index) =>
            `# Section ${index + 1} Insights\n\n${extraction}`
        ).join('\n\n---\n\n');
    }

    private combineAnalyses(analyses: string[]): string {
        // Start with a combined header
        let combined = `# Combined Analysis\n\n`;

        // Add each analysis as a section
        combined += analyses.map((analysis, index) =>
            `## Section ${index + 1} Analysis\n\n${analysis}`
        ).join('\n\n---\n\n');

        // Add a synthesis section
        combined += '\n\n---\n\n## Overall Synthesis\n\n';
        combined += 'The above sections analyze different parts of the content. ' +
            'The complete analysis provides a comprehensive understanding of the material.';

        return combined;
    }


    private async handlePatternSkip(
        adapter: ContextAdapter,
        userId: string
    ): Promise<void> {
        console.log(`[handlePatternSkip] Processing skip action`);
        await adapter.answerCallbackQuery('Processing normally...');

        // Update the message to indicate normal processing
        if (adapter.context.messageId) {
            try {
                await adapter.editMessageText(
                    `🔄 Processing content normally...\n\nThis may take a moment.`,
                    {
                        parse_mode: 'Markdown'
                    }
                );
            } catch (error) {
                console.warn('Error updating message, continuing with processing:', error);
            }
        }

        const contextData = this.conversationManager!.cache.get<PatternContextData>(`pattern_context:${userId}`);
        if (contextData && this) {
            await (this as any).processWithoutPattern(adapter, contextData);
            this.conversationManager!.cache.del(`pattern_context:${userId}`);
        }
    }



    private getContentForProcessing(
        adapter: ContextAdapter,
        userId: string,
        currentContent: string = '',
        useProcessedIfAvailable: boolean = false
    ): string {
        const methodName = 'getContentForProcessing';

        // First check for pattern data (for processed content)
        if (useProcessedIfAvailable) {
            const patternData = this.conversationManager?.cache.get<PatternData>(`pattern_data:${userId}`);
            if (patternData) {
                const lastPattern = patternData.currentPatternState.lastProcessedPattern;
                if (lastPattern && patternData.processedOutputs[lastPattern]?.output) {
                    console.log(`[${methodName}] Using previously processed content from ${lastPattern}`);
                    return patternData.processedOutputs[lastPattern].output;
                }
            }
        }

        // Then check context data for original input
        const contextData = this.conversationManager?.cache.get<PatternContextData>(`pattern_context:${userId}`);
        if (contextData?.input) {
            console.log(`[${methodName}] Using original input from context data`);
            return contextData.input;
        }

        // If provided current content, use that
        if (currentContent) {
            console.log(`[${methodName}] Using provided current content`);
            return currentContent;
        }

        // Last resort: extract from callback query message
        if (adapter.context.raw?.callbackQuery?.message?.text) {
            const messageText = adapter.context.raw.callbackQuery.message.text;
            const menuHeaderIndex = messageText.indexOf('\n\n-----\n');
            const extractedContent = menuHeaderIndex !== -1 ?
                messageText.substring(0, menuHeaderIndex) :
                messageText;

            console.log(`[${methodName}] Extracted content from callback message`);
            return extractedContent;
        }

        console.warn(`[${methodName}] Could not retrieve content for processing`);
        return '';
    }

    private async navigateResultChunks(
        adapter: ContextAdapter,
        userId: string,
        patternName: string,
        direction: string
    ): Promise<void> {
        const methodName = 'navigateResultChunks';
        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);

        if (!patternData || !patternData.processedOutputs[patternName]) {
            await adapter.answerCallbackQuery('Result not available');
            return;
        }

        const result = patternData.processedOutputs[patternName];

        // Check if chunks exist
        if (!result.chunks || result.chunks.length === 0) {
            // If there are no chunks, we might need to create them from the output
            if (result.output) {
                result.chunks = this.splitOutput(result.output);
            } else {
                await adapter.answerCallbackQuery('No content chunks available');
                return;
            }
        }

        // Initialize current chunk if not set
        if (result.currentChunk === undefined) {
            result.currentChunk = 0;
        }

        // Calculate new chunk index
        let newChunk = result.currentChunk;
        if (direction === 'next' && newChunk < result.chunks.length - 1) {
            newChunk++;
        } else if (direction === 'prev' && newChunk > 0) {
            newChunk--;
        } else if (direction === 'first') {
            newChunk = 0;
        } else if (direction === 'last') {
            newChunk = result.chunks.length - 1;
        }

        if (newChunk === result.currentChunk) {
            await adapter.answerCallbackQuery('No more chunks in that direction');
            return;
        }

        // Update current chunk index
        result.currentChunk = newChunk;
        this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 7200);

        // Update the message with new chunk
        try {
            // Update callback message with current chunk content and pagination controls
            const buttons = [
                [
                    Markup.button.callback('⬅️ Previous', `pattern_chunk:${patternName}:prev`),
                    Markup.button.callback(`${newChunk + 1}/${result.chunks.length}`, 'pattern_noop'),
                    Markup.button.callback('Next ➡️', `pattern_chunk:${patternName}:next`)
                ],
                [
                    Markup.button.callback('🔍 Apply Pattern to This Chunk', `pattern_apply_to_chunk:${patternName}:${newChunk}`),
                    Markup.button.callback('📊 Process All Chunks', `pattern_select_all_chunks`),
                    Markup.button.callback('📤 Download', `pattern_download:${patternName}`)
                ],
                [
                    Markup.button.callback('📋 Apply Another Pattern', 'pattern_back_to_menu'),
                    Markup.button.callback('🔍 Browse Input Chunks', 'pattern_browse_input'),
                    Markup.button.callback('✅ Done', 'pattern_skip')
                ]
            ];

            const keyboard = Markup.inlineKeyboard(buttons);

            await adapter.editMessageText(
                `${result.chunks[newChunk]}\n\n-----\n📝 <b>Part ${newChunk + 1} of ${result.chunks.length}</b>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: keyboard.reply_markup
                }
            );

            await adapter.answerCallbackQuery(`Showing chunk ${newChunk + 1} of ${result.chunks.length}`);
        } catch (error) {
            console.error(`[${methodName}] Error navigating:`, error);
            await adapter.answerCallbackQuery('Error navigating chunks');
        }
    }

    public storePatternInput(userId: string, input: string): void {
        // Get existing pattern data or create new
        const cacheKey = `pattern_data:${userId}`;
        let patternData = this.conversationManager!.cache.get<PatternData>(cacheKey) || {
            originalInput: input,
            processedOutputs: {},
            currentPatternState: {}
        };

        // Update input
        patternData.originalInput = input;

        // Store with extended TTL for large content
        this.conversationManager!.cache.set(cacheKey, patternData, 7200);  // 2 hour

        console.log(`[storePatternInput] Stored input for user ${userId}, length: ${input.length}`);
    }






    ////////////////////////////////////////////////////////////////////////////////////////////////////////


    private async showOriginalPatternMenu(
        adapter: ContextAdapter,
        userId: string,
        messageId?: number | string,
        currentContent: string = '',
        useSelectedChunk: boolean = false
    ): Promise<void> {
        const methodName = 'showOriginalPatternMenu';

        // Get pattern data from cache
        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);

        // Get the cached contextData to retrieve the original suggestion if possible
        const contextData = this.conversationManager!.cache.get<PatternContextData>(`pattern_context:${userId}`);
        const originalSuggestion = (contextData?.metadata as any)?.suggestion;

        // Determine which content to show in the menu
        let displayContent = '';
        // ... existing content preparation logic ...

        // Create message with content preview if available
        let message = '';

        // If we're using a selected chunk, show that info
        if (useSelectedChunk && patternData?.currentPatternState?.selectedInputChunk !== undefined) {
            const chunkIndex = patternData.currentPatternState.selectedInputChunk;
            message = `📝 <b>Apply pattern to selected chunk ${chunkIndex + 1}</b>\n\n`;

            if (displayContent) {
                message += `<b>Preview:</b>\n${displayContent}\n\n`;
            }

            message += `<b>Select a pattern to apply:</b>`;
        } else {
            // Standard menu without preview
            message = '📝 <b>Try another pattern on the content:</b>';
        }

        // Use MenuManager to create the pattern menu
        const keyboard = this.menuManager!.createPatternSelectionMenu(
            originalSuggestion,
            originalSuggestion?.alternativePatterns
        ).reply_markup;

        // Update the message
        if (messageId) {
            try {
                await adapter.editMessageText(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } catch (error) {
                console.warn(`[${methodName}] Error updating message, sending new one:`, error);
                await adapter.reply(message, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                });
            }
        } else {
            await adapter.reply(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
        }
    }
    // In CommandHandler.ts

    private async showPatternCategories(
        adapter: ContextAdapter,
        patternAgent: PatternPromptAgent,
        messageId?: number | string,
        currentContent: string = ''
    ): Promise<void> {
        console.log(`[showPatternCategories] Showing pattern categories`);

        const categories = patternAgent.getCategories();

        // Use MenuManager to create the categories menu
        const keyboard = this.menuManager!.createPatternCategoriesMenu(categories).reply_markup;

        await adapter.answerCallbackQuery('Showing pattern categories...');

        // Create message with preserved content (with truncation if needed)
        let message = '';
        if (currentContent) {
            // Truncate content if too long to avoid MESSAGE_TOO_LONG errors
            const maxDisplayLength = 300; // Shorter for UI purposes
            if (currentContent.length > maxDisplayLength) {
                message = currentContent.substring(0, maxDisplayLength) + '...\n\n-----\n';
            } else {
                message = currentContent + '\n\n-----\n';
            }
        }

        message += '📋 <b>Select a Pattern Category</b>\n\nChoose a category to see available processing patterns:';

        if (messageId) {
            // Update existing message
            try {
                await adapter.editMessageText(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } catch (error) {
                console.warn('Error updating message, sending new one:', error);
                // If message is too long, send a new message without the content
                if (error.response?.description?.includes('MESSAGE_TOO_LONG')) {
                    await adapter.reply(
                        '📋 <b>Select a Pattern Category</b>\n\nChoose a category to see available processing patterns:',
                        {
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        }
                    );
                } else {
                    await adapter.reply(message, {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    });
                }
            }
        } else {
            // Send new message
            await adapter.reply(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
        }
    }

    private async showCategoryPatterns(
        adapter: ContextAdapter,
        patternAgent: PatternPromptAgent,
        category: string,
        messageId?: number | string,
        page: number = 0,
        currentContent: string = ''
    ): Promise<void> {
        console.log(`[showCategoryPatterns] Showing patterns for category:`, category);

        const patterns = patternAgent.getPatternsByCategory(category);
        const patternsPerPage = 6; // Show 6 patterns per page
        const totalPages = Math.ceil(patterns.length / patternsPerPage);

        // Ensure page is within bounds
        page = Math.max(0, Math.min(page, totalPages - 1));

        // Get patterns for current page
        const patternsForPage = patterns.slice(page * patternsPerPage, (page + 1) * patternsPerPage);

        // Use MenuManager to create the patterns menu
        const keyboard = this.menuManager!.createCategoryPatternsMenu(
            patternsForPage,
            category,
            page,
            totalPages
        ).reply_markup;

        await adapter.safeAnswerCallbackQuery(`Showing ${category} patterns...`);

        // Create message with preserved content (with truncation if needed)
        let message = '';
        if (currentContent) {
            // Truncate content if too long to avoid MESSAGE_TOO_LONG errors
            const maxDisplayLength = 300; // Shorter for UI purposes
            if (currentContent.length > maxDisplayLength) {
                message = currentContent.substring(0, maxDisplayLength) + '...\n\n-----\n';
            } else {
                message = currentContent + '\n\n-----\n';
            }
        }

        message += `📋 <b>${this.menuManager!.formatCategoryName(category)} Patterns</b>\n\n` +
            `Page ${page + 1}/${totalPages}\n\n` +
            `Select a pattern to process your content:`;

        if (messageId) {
            // Update existing message
            try {
                await adapter.editMessageText(
                    message,
                    {
                        parse_mode: 'HTML',  // Changed to HTML for consistency
                        reply_markup: keyboard
                    }
                );
            } catch (error) {
                console.warn('Error updating message, sending new one:', error);
                // If message is too long, send a new message without the content
                if (error.response?.description?.includes('MESSAGE_TOO_LONG')) {
                    await adapter.reply(
                        `📋 <b>${this.menuManager!.formatCategoryName(category)} Patterns</b>\n\n` +
                        `Page ${page + 1}/${totalPages}\n\n` +
                        `Select a pattern to process your content:`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        }
                    );
                } else {
                    await adapter.reply(message, {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    });
                }
            }
        } else {
            // Send new message
            await adapter.reply(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
        }
    }

    // In CommandHandler.ts

    private async showAdvancedPatternMenu(
        adapter: ContextAdapter,
        userId: string,
        messageId?: number | string
    ): Promise<void> {
        const methodName = 'showAdvancedPatternMenu';

        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
        if (!patternData) {
            await adapter.answerCallbackQuery('Pattern data not available');
            return;
        }

        const patternAgent = this.agentManager!.getAgent('pattern') as PatternPromptAgent;
        if (!patternAgent) {
            throw new Error('Pattern agent not available');
        }

        // Basic info about available content
        let availableContent = '';

        // Check if we have original input
        if (patternData.originalInput) {
            availableContent += `- Original input (${patternData.originalInput.length} chars)\n`;
        }

        // Check if we have input chunks
        if (patternData.inputChunks?.chunks?.length) {
            availableContent += `- Input chunks (${patternData.inputChunks.chunks.length} chunks)\n`;
        }

        // Check if we have processed outputs
        const outputPatterns = Object.keys(patternData.processedOutputs || {});
        if (outputPatterns.length > 0) {
            availableContent += `- Processed outputs: ${outputPatterns.join(', ')}\n`;
        }

        // Use MenuManager to create the advanced pattern menu
        const hasInputChunks = !!patternData.inputChunks?.chunks?.length;
        const hasProcessedOutputs = outputPatterns.length > 0;
        const keyboard = this.menuManager!.createAdvancedPatternMenu(
            hasInputChunks,
            hasProcessedOutputs,
            outputPatterns
        ).reply_markup;

        // Create the menu message
        const message = `📝 <b>Advanced Pattern Processing</b>\n\n` +
            `Choose which content to process and how:\n\n` +
            `${availableContent}\n` +
            `Select an option to continue:`;

        try {
            if (messageId) {
                await adapter.editMessageText(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } else {
                await adapter.reply(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            }
        } catch (error) {
            console.warn(`[${methodName}] Error showing menu:`, error);
            // Try without the availableContent section if it might be too long
            const shorterMessage = `📝 <b>Advanced Pattern Processing</b>\n\nChoose which content to process and how:`;

            if (messageId) {
                await adapter.editMessageText(
                    shorterMessage,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } else {
                await adapter.reply(
                    shorterMessage,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            }
        }
    }

    private async showOutputActionsMenu(
        adapter: ContextAdapter,
        userId: string,
        patternName: string,
        messageId?: number | string
    ): Promise<void> {
        const methodName = 'showOutputActionsMenu';

        // Use MenuManager to create the output actions menu
        const keyboard = this.menuManager!.createOutputActionsMenu(patternName).reply_markup;

        const menuMessage = `✨ <b>Processing complete with ${patternName}</b>\n\nWhat would you like to do next?`;

        if (messageId) {
            try {
                await adapter.editMessageText(
                    menuMessage,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } catch (error) {
                console.warn(`[${methodName}] Error editing message:`, error);
                await adapter.reply(menuMessage, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                });
            }
        } else {
            await adapter.reply(menuMessage, {
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
        }
    }

    private async processAllChunks(
        adapter: ContextAdapter,
        userId: string,
        patternName: string
    ): Promise<void> {
        const methodName = 'processAllChunks';
        
        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
        if (!patternData) {
            await adapter.answerCallbackQuery('Pattern data not available');
            return;
        }
        
        // Ensure input chunks exist
        if (!patternData.inputChunks?.chunks || patternData.inputChunks.chunks.length === 0) {
            await adapter.answerCallbackQuery('No input chunks available for processing');
            return;
        }
        
        const chunks = patternData.inputChunks.chunks;
        const chunkCount = chunks.length;
        
        await adapter.safeAnswerCallbackQuery(`Processing ${chunkCount} chunks with ${patternName}...`);
        
        // Show processing message
        const menuMessageId = adapter.context.messageId;
        if (menuMessageId) {
            try {
                await adapter.editMessageText(
                    `🔄 Processing ${chunkCount} chunks with ${patternName}...\n\nThis may take a while.`,
                    { parse_mode: 'HTML' }
                );
            } catch (error) {
                console.warn(`[${methodName}] Error updating message:`, error);
            }
        }
        
        const patternAgent = this.agentManager!.getAgent('pattern') as PatternPromptAgent;
        if (!patternAgent) {
            throw new Error('Pattern agent not available');
        }
        
        // Process each chunk
        const results: Array<{
            chunk: number;
            result?: string;
            error?: string;
        }> = [];
        
        for (let i = 0; i < chunkCount; i++) {
            // Update progress message
            if (menuMessageId) {
                try {
                    await adapter.editMessageText(
                        `🔄 Processing chunk ${i+1}/${chunkCount} with ${patternName}...\n\nThis may take a while.`,
                        { parse_mode: 'HTML' }
                    );
                } catch (error) {
                    console.warn(`[${methodName}] Error updating progress:`, error);
                }
            }
            
            // Process the current chunk
            try {
                const result = await patternAgent.processWithPattern(patternName, chunks[i], adapter);
                results.push({ chunk: i, result });
            } catch (error) {
                console.error(`[${methodName}] Error processing chunk ${i}:`, error);
                results.push({ chunk: i, error: error instanceof Error ? error.message : String(error) });
            }
            
            // Small delay between chunks to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // Store combined results
        const batchKey = `${patternName}_batch_${Date.now()}`;
        
        patternData.processedOutputs[batchKey] = {
            output: `Batch processing results for ${patternName} on ${chunkCount} chunks`,
            timestamp: Date.now(),
            batchResults: results.map(r => r.result || `Error: ${r.error}`),
            chunks: results.map(r => r.result || `Error: ${r.error}`),
            isBatch: true
        };
        
        this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 3600);
        
        // Use MenuManager to create the batch completion menu
        const keyboard = this.menuManager!.createBatchCompletionMenu(batchKey).reply_markup;
        
        // Show completion message and menu
        try {
            await adapter.editMessageText(
                `✅ <b>Batch processing complete!</b>\n\n` +
                `Successfully processed ${results.filter(r => r.result).length}/${chunkCount} chunks with ${patternName}.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                }
            );
        } catch (error) {
            console.warn(`[${methodName}] Error showing completion message:`, error);
            
            // Fallback: send a new message
            await adapter.reply(
                `✅ <b>Batch processing complete!</b>\n\n` +
                `Successfully processed ${results.filter(r => r.result).length}/${chunkCount} chunks with ${patternName}.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                }
            );
        }
        
        // Send a summary of the batch processing
        const summaryChunks = [];
        for (let i = 0; i < results.length; i += 5) {
            const chunkSummary = results.slice(i, i + 5).map(r => {
                if (r.result) {
                    // For each result, take just the first line or first 100 chars
                    const preview = r.result.split('\n')[0].substring(0, 100);
                    return `Chunk ${r.chunk + 1}: ${preview}${preview.length >= 100 ? '...' : ''}`;
                } else {
                    return `Chunk ${r.chunk + 1}: Error: ${r.error}`;
                }
            }).join('\n\n');
            
            summaryChunks.push(chunkSummary);
        }
        
        // Send the summary chunks
        for (const summary of summaryChunks) {
            await adapter.reply(
                `<b>Batch Processing Summary (${patternName}):</b>\n\n${summary}`,
                { parse_mode: 'HTML' }
            );
        }
    }

   
    // In CommandHandler.ts

    private async navigateInputChunks(
        adapter: ContextAdapter,
        userId: string,
        direction: string
    ): Promise<void> {
        const methodName = 'navigateInputChunks';
        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);

        if (!patternData) {
            await adapter.answerCallbackQuery('Input data not available');
            return;
        }

        // Ensure input chunks exist
        if (!patternData.inputChunks || !patternData.inputChunks.chunks || patternData.inputChunks.chunks.length === 0) {
            // If no chunks yet, create them
            if (patternData.originalInput) {
                patternData.inputChunks = {
                    chunks: this.splitInput(patternData.originalInput),
                    currentChunk: 0,
                    lastAccessed: Date.now()
                };
            } else {
                await adapter.answerCallbackQuery('No input content available');
                return;
            }
        }

        // Get current chunk index
        let currentIndex = patternData.inputChunks.currentChunk || 0;

        // Calculate new chunk index
        let newIndex = currentIndex;
        if (direction === 'next' && newIndex < patternData.inputChunks.chunks.length - 1) {
            newIndex++;
        } else if (direction === 'prev' && newIndex > 0) {
            newIndex--;
        } else if (direction === 'first') {
            newIndex = 0;
        } else if (direction === 'last') {
            newIndex = patternData.inputChunks.chunks.length - 1;
        }

        if (newIndex === currentIndex) {
            await adapter.answerCallbackQuery('No more input chunks in that direction');
            return;
        }

        // Update current chunk index
        patternData.inputChunks.currentChunk = newIndex;
        patternData.inputChunks.lastAccessed = Date.now();
        patternData.currentPatternState.selectedInputChunk = newIndex;
        this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 7200);

        // Use MenuManager to create input chunk navigation menu
        const keyboard = this.menuManager!.createInputChunkNavigationMenu(
            newIndex,
            patternData.inputChunks.chunks.length
        ).reply_markup;

        // Display the selected input chunk
        try {
            await adapter.editMessageText(
                `${patternData.inputChunks.chunks[newIndex]}\n\n-----\n📝 <b>Input Chunk ${newIndex + 1} of ${patternData.inputChunks.chunks.length}</b>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                }
            );

            await adapter.answerCallbackQuery(`Showing input chunk ${newIndex + 1} of ${patternData.inputChunks.chunks.length}`);
        } catch (error) {
            console.error(`[${methodName}] Error displaying input chunk:`, error);
            await adapter.answerCallbackQuery('Error displaying input chunk');
        }
    }

    private async showPatternMenuForChunk(
        adapter: ContextAdapter,
        userId: string,
        sourceName: string,
        chunkIndex: number,
        messageId?: number | string
    ): Promise<void> {
        const methodName = 'showPatternMenuForChunk';

        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
        if (!patternData) {
            await adapter.answerCallbackQuery('Pattern data not available');
            return;
        }

        // Check if the source data exists
        let chunkContent: string;

        if (sourceName === 'original') {
            // Using a chunk from the original input
            if (patternData.inputChunks?.chunks &&
                patternData.inputChunks.chunks.length > chunkIndex) {
                chunkContent = patternData.inputChunks.chunks[chunkIndex];
            } else {
                await adapter.answerCallbackQuery('Original input chunk not found');
                return;
            }
        } else {
            // Using a chunk from a previous pattern output
            const sourceOutput = patternData.processedOutputs[sourceName];
            if (sourceOutput?.chunks && sourceOutput.chunks.length > chunkIndex) {
                chunkContent = sourceOutput.chunks[chunkIndex];
            } else {
                await adapter.answerCallbackQuery('Source chunk not found');
                return;
            }
        }

        // Store the selection in the current pattern state
        patternData.currentPatternState.useProcessedOutput = sourceName;
        patternData.currentPatternState.selectedInputChunk = chunkIndex;
        this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 7200);

        // Create standard patterns list
        const standardPatterns = [
            { name: 'summarize', emoji: '📝' },
            { name: 'improve_writing', emoji: '✍️' },
            { name: 'extract_wisdom', emoji: '💡' },
            { name: 'write_essay', emoji: '📚' }
        ];

        // Use MenuManager to create the pattern menu for chunk
        const keyboard = this.menuManager!.createChunkPatternMenu(standardPatterns).reply_markup;

        // Display source info
        const sourceInfo = sourceName === 'original' ?
            `Original Input (Chunk ${chunkIndex + 1})` :
            `${sourceName} Result (Chunk ${chunkIndex + 1})`;

        // Show a preview of the chunk content (truncated if needed)
        const maxPreviewLength = 300;
        const contentPreview = chunkContent.length > maxPreviewLength ?
            chunkContent.substring(0, maxPreviewLength) + '...' :
            chunkContent;

        const message = `📝 <b>Apply Pattern to Chunk</b>\n\n` +
            `<b>Source:</b> ${sourceInfo}\n\n` +
            `<b>Preview:</b>\n${contentPreview}\n\n` +
            `<b>Select a pattern to apply:</b>`;

        try {
            if (messageId) {
                await adapter.editMessageText(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } else {
                await adapter.reply(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            }
        } catch (error) {
            console.warn(`[${methodName}] Error showing menu:`, error);

            // Try with shorter preview if it might be too long
            const shorterMessage = `📝 <b>Apply Pattern to Chunk</b>\n\n` +
                `<b>Source:</b> ${sourceInfo}\n\n` +
                `<b>Select a pattern to apply:</b>`;

            if (messageId) {
                await adapter.editMessageText(
                    shorterMessage,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } else {
                await adapter.reply(
                    shorterMessage,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            }
        }
    }

    private async viewBatchResult(
        adapter: ContextAdapter,
        userId: string,
        batchKey: string,
        index: number
    ): Promise<void> {
        const methodName = 'viewBatchResult';
        
        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
        if (!patternData || !patternData.processedOutputs[batchKey]) {
            await adapter.answerCallbackQuery('Batch results not available');
            return;
        }
        
        const batch = patternData.processedOutputs[batchKey];
        if (!batch.batchResults || !Array.isArray(batch.batchResults)) {
            await adapter.answerCallbackQuery('Invalid batch data format');
            return;
        }
        
        const results = batch.batchResults;
        if (index < 0 || index >= results.length) {
            await adapter.answerCallbackQuery('Result index out of range');
            return;
        }
        
        const result = results[index];
        
        // Use MenuManager to create the batch result navigation menu
        const keyboard = this.menuManager!.createBatchResultNavigationMenu(
            batchKey,
            index,
            results.length
        ).reply_markup;
        
        // Send the result
        await adapter.reply(
            `<b>Chunk ${index + 1} Result:</b>\n\n${result}`,
            {
                parse_mode: 'HTML',
                reply_markup: keyboard
            }
        );
        
        await adapter.answerCallbackQuery(`Showing result for chunk ${index + 1}`);
    }

    private async showPatternMenuForAllChunks(
        adapter: ContextAdapter,
        userId: string,
        messageId?: number | string
    ): Promise<void> {
        const methodName = 'showPatternMenuForAllChunks';
        
        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
        if (!patternData) {
            await adapter.answerCallbackQuery('Pattern data not available');
            return;
        }
        
        // Ensure input chunks exist
        if (!patternData.inputChunks?.chunks || patternData.inputChunks.chunks.length === 0) {
            // If no chunks yet, create them
            if (patternData.originalInput) {
                patternData.inputChunks = {
                    chunks: this.splitInput(patternData.originalInput),
                    currentChunk: 0,
                    lastAccessed: Date.now()
                };
                this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 3600);
            } else {
                await adapter.answerCallbackQuery('No input content available for chunking');
                return;
            }
        }
        
        const chunkCount = patternData.inputChunks.chunks.length;
        
        // Use MenuManager to create the batch processing menu
        const keyboard = this.menuManager!.createBatchProcessingMenu(chunkCount).reply_markup;
        
        const message = `📝 <b>Batch Process All Chunks</b>\n\n` +
                       `The content has been split into ${chunkCount} chunks.\n\n` +
                       `Select a pattern to apply to all chunks:`;
        
        try {
            if (messageId) {
                await adapter.editMessageText(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } else {
                await adapter.reply(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            }
        } catch (error) {
            console.warn(`[${methodName}] Error showing menu:`, error);
        }
    }
    private async showProcessedOutputsMenu(
        adapter: ContextAdapter,
        userId: string,
        messageId?: number | string
    ): Promise<void> {
        const methodName = 'showProcessedOutputsMenu';
        
        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
        if (!patternData || !patternData.processedOutputs) {
            await adapter.answerCallbackQuery('No processed outputs available');
            return;
        }
        
        const outputPatterns = Object.keys(patternData.processedOutputs);
        if (outputPatterns.length === 0) {
            await adapter.answerCallbackQuery('No processed outputs available');
            return;
        }
        
        // Use MenuManager to create the processed outputs menu
        const keyboard = this.menuManager!.createProcessedOutputsMenu(outputPatterns).reply_markup;
        
        const message = `📝 <b>Choose a Processed Result</b>\n\n` +
                       `Select a previous result to use as input for a new pattern:`;
        
        try {
            if (messageId) {
                await adapter.editMessageText(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } else {
                await adapter.reply(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            }
        } catch (error) {
            console.warn(`[${methodName}] Error showing menu:`, error);
        }
    }
    private formatCategoryName(category: string): string {
        return category.charAt(0).toUpperCase() + category.slice(1);
    }
    public async cleanup(): Promise<void> {
        console.log(`[FlowID: ${this.flowId}] Starting CommandHandler cleanup...`);

        // Unregister all commands from the bot
        if (this.bot) {
            // This is a placeholder - the actual method to unregister commands may vary
            // depending on the Telegraf API or your implementation
            // await this.bot.unregisterAllCommands();
        }

        // Clear command cache if any
        // this.commandCache.clear();

        // Clear any stored state
        this.botIds = [];
        this.botCommandMenus.clear();
        this.botInfo = [];

        console.log(`[FlowID: ${this.flowId}] CommandHandler cleanup completed.`);
    }

    // Add the splitOutput method
    private splitOutput(output: string): string[] {
        // Intelligent splitting that respects markdown and paragraphs
        const chunks: string[] = [];
        let remaining = output;

        while (remaining.length > 0) {
            let chunkSize = Math.min(4000, remaining.length);

            // Find suitable break points (paragraph, sentence, or word)
            if (chunkSize < remaining.length) {
                const paragraphBreak = remaining.lastIndexOf('\n\n', chunkSize);
                const sentenceBreak = remaining.lastIndexOf('. ', chunkSize);
                const wordBreak = remaining.lastIndexOf(' ', chunkSize);

                if (paragraphBreak > chunkSize - 200) {
                    chunkSize = paragraphBreak + 2;
                } else if (sentenceBreak > chunkSize - 100) {
                    chunkSize = sentenceBreak + 2;
                } else if (wordBreak > chunkSize - 50) {
                    chunkSize = wordBreak + 1;
                }
            }

            chunks.push(remaining.substring(0, chunkSize));
            remaining = remaining.substring(chunkSize);
        }

        return chunks;
    }

    private storePatternOutput(
        userId: string,
        patternName: string,
        output: string,
        options?: {
            sourceName?: string;
            sourceChunkIndex?: number;
        }
    ): void {
        const cacheKey = `pattern_data:${userId}`;
        let patternData = this.conversationManager!.cache.get<PatternData>(cacheKey);

        if (!patternData) {
            console.warn(`[storePatternOutput] No pattern data found for user ${userId}`);
            return;
        }

        // Initialize or update the output entry for this pattern
        if (!patternData.processedOutputs) {
            patternData.processedOutputs = {};
        }

        patternData.processedOutputs[patternName] = {
            output,
            timestamp: Date.now(),
            chunks: output.length > 4000 ? this.splitOutput(output) : undefined,
            sourceName: options?.sourceName,
            sourceChunkIndex: options?.sourceChunkIndex
        };

        // Update pattern state
        patternData.currentPatternState.lastProcessedPattern = patternName;

        // Store in cache
        this.conversationManager!.cache.set(cacheKey, patternData, 7200);

        console.log(`[storePatternOutput] Stored output for pattern ${patternName}, user ${userId}, length: ${output.length}`);
    }

}