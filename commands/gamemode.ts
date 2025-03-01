import { Command } from './types'

export const gameModeCommand: Command = {
    name: 'gamemode',
    description: 'Enter game mode',
    execute: async (ctx, conversationManager, memory, sessionId) => {
        if (!conversationManager) {
            await ctx.reply("Bot is not fully initialized. Please try again later.");
            return;
        }
        await ctx.reply("Game mode is not implemented yet.");
    }
}