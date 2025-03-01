import { Command } from './types'

export const toolSelectCommand: Command = {
    name: 'toolselect',
    description: 'Select a specific tool or capability',
    execute: async (ctx, conversationManager, memory, sessionId) => {
        if (!conversationManager) {
            await ctx.reply("Bot is not fully initialized. Please try again later.");
            return;
        }
        await ctx.reply("Tool selection functionality is not implemented yet.");
    }
}