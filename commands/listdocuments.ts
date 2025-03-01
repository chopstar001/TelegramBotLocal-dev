import { Command } from './types'

export const listDocumentsCommand: Command = {
    name: 'listdocuments',
    description: 'List available documents',
    execute: async (ctx, conversationManager, memory, sessionId) => {
        if (!conversationManager) {
            await ctx.reply("Bot is not fully initialized. Please try again later.");
            return;
        }
        await ctx.reply("Document listing functionality is not implemented yet.");
    }
}