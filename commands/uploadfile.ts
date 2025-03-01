import { Command } from './types'

export const uploadFileCommand: Command = {
    name: 'uploadfile',
    description: 'Upload a file to the knowledge base',
    execute: async (ctx, conversationManager, memory, sessionId) => {
        if (!conversationManager) {
            await ctx.reply("Bot is not fully initialized. Please try again later.");
            return;
        }
        await ctx.reply("File upload functionality is not implemented yet.");
    }
}