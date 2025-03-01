// sourceCiteCommand.ts
import { Command } from './types'
import { RAGAgent } from '../agents/RAGAgent'

export const sourceCiteCommand: Command = {
    name: 'sourcecite',
    description: 'Toggle source citations in responses',
    execute: async (ctx, conversationManager, memory, userId, sessionId, promptManager, telegramBot) => {
        try {
            await telegramBot.waitForInitialization();

            const agentManager = telegramBot.getAgentManager();
            if (!agentManager) {
                await ctx.reply("Bot is not fully initialized. Please try again later.");
                return;
            }
            
            const agent = agentManager.getAgent('rag');
            if (!(agent instanceof RAGAgent)) {
                await ctx.reply("Source citation is not available with the current agent.");
                return;
            }

            const currentStatus = agent.isRAGModeEnabled(userId);
            agent.toggleRAGMode(userId, !currentStatus);

            const statusMessage = !currentStatus
                ? "Source citations have been enabled. Responses will now include citations when relevant."
                : "Source citations have been disabled. Responses will no longer include citations.";

            await ctx.reply(statusMessage);
        } catch (error) {
            console.error("Error in sourceCiteCommand:", error);
            await ctx.reply("An error occurred while processing your command. Please try again later.");
        }
    }
}