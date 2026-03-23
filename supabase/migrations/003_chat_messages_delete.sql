-- Allow users to delete their own AI chat history (Clear Chat)
-- Run in Supabase SQL Editor if policies already exist and this fails.

drop policy if exists "chat_messages_delete_own" on public.chat_messages;

create policy "chat_messages_delete_own"
  on public.chat_messages for delete
  using (auth.uid() = user_id);
