/**
 * Conversation Manager
 *
 * Manages conversation state in the sms_conversations table.
 * State machine: idle → awaiting_disambiguation → ready_for_confirmation → idle
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const CONVERSATION_TTL_MINUTES = 10;

/**
 * Get the active conversation for a phone number, or null if none/expired.
 *
 * @param {string} phoneNumber - E.164 phone number
 * @returns {Promise<Object|null>}
 */
async function getConversation(phoneNumber) {
  const { data, error } = await supabase
    .from('sms_conversations')
    .select('*')
    .eq('phone_number', phoneNumber)
    .neq('state', 'idle')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (error) {
    console.error('[ConversationManager] getConversation error:', error.message);
    return null;
  }

  return data || null;
}

/**
 * Create or update a conversation to a new state.
 *
 * @param {string} phoneNumber
 * @param {string} userId
 * @param {string} state - One of the valid sms_conversations states
 * @param {Object} context - JSONB context to store (partial update merged in JS)
 * @param {string|null} agentphoneConversationId
 * @returns {Promise<Object>} The upserted conversation record
 */
async function setConversationState(phoneNumber, userId, state, context = {}, agentphoneConversationId = null) {
  const expiresAt = new Date(Date.now() + CONVERSATION_TTL_MINUTES * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('sms_conversations')
    .upsert(
      {
        phone_number: phoneNumber,
        user_id: userId,
        state,
        context,
        agentphone_conversation_id: agentphoneConversationId,
        last_message_at: new Date().toISOString(),
        expires_at: expiresAt,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'phone_number' }
    )
    .select()
    .single();

  if (error) {
    console.error('[ConversationManager] setConversationState error:', error.message);
    throw error;
  }

  return data;
}

/**
 * Reset a conversation back to idle (clears context).
 *
 * @param {string} phoneNumber
 */
async function resetConversation(phoneNumber) {
  const { error } = await supabase
    .from('sms_conversations')
    .update({
      state: 'idle',
      context: {},
      updated_at: new Date().toISOString()
    })
    .eq('phone_number', phoneNumber);

  if (error) {
    console.error('[ConversationManager] resetConversation error:', error.message);
  }
}

/**
 * Merge additional data into an existing conversation's context.
 *
 * @param {string} phoneNumber
 * @param {Object} contextPatch - Fields to merge into existing context
 */
async function updateConversationContext(phoneNumber, contextPatch) {
  // Fetch current context first, then merge
  const { data: current, error: fetchError } = await supabase
    .from('sms_conversations')
    .select('context')
    .eq('phone_number', phoneNumber)
    .maybeSingle();

  if (fetchError || !current) {
    console.error('[ConversationManager] updateConversationContext: could not fetch current', fetchError?.message);
    return;
  }

  const mergedContext = { ...(current.context || {}), ...contextPatch };

  const { error } = await supabase
    .from('sms_conversations')
    .update({
      context: mergedContext,
      updated_at: new Date().toISOString()
    })
    .eq('phone_number', phoneNumber);

  if (error) {
    console.error('[ConversationManager] updateConversationContext update error:', error.message);
  }
}

module.exports = {
  getConversation,
  setConversationState,
  resetConversation,
  updateConversationContext
};
