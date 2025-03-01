import { Command } from './types'

export const compareInfoCommand: Command = {
    name: 'compareinfo',
    description: 'Compare information from multiple sources',
    execute: async (ctx, conversationManager, memory, sessionId) => {
        if (!conversationManager) {
            await ctx.reply("Bot is not fully initialized. Please try again later.");
            return;
        }
        await ctx.reply("Information comparison is not implemented yet.");
    }
}