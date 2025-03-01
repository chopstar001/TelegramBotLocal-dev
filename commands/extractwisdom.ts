import { Command } from './types'

export const extractWisdomCommand: Command = {
    name: 'extractwisdom',
    description: 'Extract wisdom from text',
    execute: async (ctx, conversationManager, memory, sessionId) => {
        if (!conversationManager) {
            await ctx.reply("Bot is not fully initialized. Please try again later.");
            return;
        }
        await ctx.reply("Wisdom extraction is not implemented yet.");
    }
}