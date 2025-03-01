import { Command } from './types'

export const summarizeCommand: Command = {
    name: 'summarize',
    description: 'Summarize a document or conversation',
    execute: async (ctx, conversationManager, memory, sessionId) => {
        if (!conversationManager) {
            await ctx.reply("Bot is not fully initialized. Please try again later.");
            return;
        }
        await ctx.reply("Summarization functionality is not implemented yet.");
    }
}