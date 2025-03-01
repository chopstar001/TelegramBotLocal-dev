import { Command } from './types';
import { ConversationManager } from '../ConversationManager';
import { IExtendedMemory, ExtendedIMessage } from './types';
import { MessageType } from '../../../../src/Interface';
import { PromptManager } from '../PromptManager';
import { RAGAgent } from '../agents/RAGAgent';
import { TelegramBot_Agents } from '../TelegramBot_Agents';
import { ContextAdapter } from '../ContextAdapter';
import { logInfo, logError, logWarn } from '../loggingUtility';
import { handlePlatformSpecificResponse } from '../utils/utils';

export const ragModeCommand: Command = {
    name: 'ragmode',
    description: 'Toggle Q&A Retrieval-Augmented Generation (RAG) mode',
    execute: async (adapter: ContextAdapter, conversationManager: ConversationManager, memory: IExtendedMemory | null, userId: string, sessionId: string, promptManager: PromptManager | null, telegramBot: TelegramBot_Agents) => {
        const methodName = 'ragModeCommand';

        if (!conversationManager) {
            await adapter.reply("Bot is not fully initialized. Please try again later.");
            return;
        }

        const agentManager = conversationManager.getAgentManager();
        if (!agentManager) {
            await adapter.reply("Agent Manager is not initialized. Cannot toggle RAG mode.");
            return;
        }

        const ragAgent = agentManager.getAgent('rag') as RAGAgent;
        if (!ragAgent || !('isRAGModeEnabled' in ragAgent) || !('toggleRAGMode' in ragAgent)) {
            await adapter.reply("RAG Agent is not available or doesn't support mode toggling.");
            return;
        }

        const currentMode = ragAgent.isRAGModeEnabled(userId);
        const newMode = !currentMode;
        ragAgent.toggleRAGMode(userId, newMode);

        // Get the user's first name
        const context = adapter.getMessageContext();
        const userFirstName = context.username || 'User';

        const replyMessage = newMode
            ? `✅ RAG (Q&A) mode is now enabled for user: '${userFirstName}'. I will use contextual information to provide more detailed answers.`
            : `⭕️ RAG mode is now disabled for user: '${userFirstName}'. I will provide answers based on my general knowledge.`;

        // Send the message and store the sent message object
        const sentMessage = await adapter.reply(replyMessage);

        // Set a timer to delete the message after 30 seconds
        setTimeout(async () => {
            try {
                await adapter.deleteMessage(sentMessage.message_id);
            } catch (error) {
                logError(methodName, 'Error deleting RAG mode confirmation message:', error);
            }
        }, 30000); // 30000 milliseconds = 30 seconds

        if (memory && promptManager) {
            const messageChunks = promptManager.splitAndTruncateMessage(replyMessage);
            for (let i = 0; i < messageChunks.length; i++) {
                const chunk = messageChunks[i];
                const chunkMessages: ExtendedIMessage[] = [
                    { message: i === 0 ? '/ragmode' : 'Continued...', text: i === 0 ? '/ragmode' : 'Continued...', type: 'userMessage' as MessageType },
                    { message: chunk, text: chunk, type: 'apiMessage' as MessageType }
                ];
                await memory.addChatMessagesExtended(chunkMessages, userId, sessionId);
            }
        }

        logInfo(methodName, `RAG mode ${newMode ? 'enabled' : 'disabled'} for user ${userId} in session ${sessionId}`);
        
        // Handle platform-specific responses
        await handlePlatformSpecificResponse(
            adapter,
            async () => {
                // Telegram-specific actions (if any)
                // For example, updating inline keyboards or sending additional messages
            },
            [
                { command: '/help', description: 'Show available commands' },
                { command: '/start', description: 'Start the bot' },
                // Add other relevant commands here
            ]
        );

        // If this was called from a callback query (i.e., the "Toggle Off RAG Mode" button), answer the query
        if (context.callbackQuery) {
            await adapter.answerCallbackQuery(newMode ? "RAG Q&A mode has been turned on." : "RAG Q&A mode has been turned off.");
        }

        // Optionally, you can add a message to indicate the chat type
        const chatType = context.raw?.chat?.type;
        if (chatType === 'group' || chatType === 'supergroup') {
            const groupMessage = await adapter.reply("👉 Note: RAG (Q&A) mode has been toggled in a group chat. This affects how I respond to your messages in this group.");
            
            // Set a timer to delete the group message after 30 seconds
            setTimeout(async () => {
                try {
                    await adapter.deleteMessage(groupMessage.message_id);
                } catch (error) {
                    logError(methodName, 'Error deleting RAG mode group chat message:', error);
                }
            }, 30000); // 30000 milliseconds = 30 seconds
        }
    }
};