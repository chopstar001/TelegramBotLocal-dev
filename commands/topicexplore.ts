import { Command } from './types'

export const topicExploreCommand: Command = {
    name: 'topicexplore',
    description: 'Explore related topics',
    execute: async (ctx, conversationManager, memory, sessionId) => {
        if (!conversationManager) {
            await ctx.reply("Bot is not fully initialized. Please try again later.");
            return;
        }
        await ctx.reply("Topic exploration is not implemented yet.");
    }
}