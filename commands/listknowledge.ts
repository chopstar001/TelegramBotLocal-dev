import { Command } from './types'

export const listKnowledgeCommand: Command = {
    name: 'listknowledge',
    description: 'List knowledge domains',
    execute: async (ctx, conversationManager, memory, sessionId) => {
        if (!conversationManager) {
            await ctx.reply("Bot is not fully initialized. Please try again later.");
            return;
        }
        await ctx.reply("Knowledge listing functionality is not implemented yet.");
    }
}