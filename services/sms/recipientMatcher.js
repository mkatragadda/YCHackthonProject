/**
 * Recipient Matcher
 *
 * Resolves a recipient string (e.g. "mom", "Maria") to a wise_recipient record.
 * Match priority:
 *   1. Exact nickname match via wise_recipient_nicknames
 *   2. Fuzzy name match on wise_recipients.account_holder_name
 *   3. Not found
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

/**
 * @param {string} recipientStr - Raw recipient string from SMS ("mom", "Maria Garcia", etc.)
 * @param {string} userId - Authenticated user's UUID
 * @returns {Promise<{
 *   status: 'matched' | 'multiple' | 'not_found',
 *   recipient?: Object,
 *   matches?: Object[],
 *   matchType?: 'nickname' | 'name'
 * }>}
 */
async function matchRecipient(recipientStr, userId) {
  const normalized = recipientStr.toLowerCase().trim();

  // 1. Exact nickname match
  const { data: byNickname, error: nicknameError } = await supabase
    .from('wise_recipient_nicknames')
    .select(`
      wise_recipient_id,
      nickname,
      wise_recipients!inner (*)
    `)
    .eq('user_id', userId)
    .ilike('nickname', normalized)
    .eq('wise_recipients.is_active', true)
    .maybeSingle();

  if (nicknameError) {
    console.error('[RecipientMatcher] Nickname lookup error:', nicknameError.message);
  }

  if (byNickname?.wise_recipients) {
    return {
      status: 'matched',
      recipient: byNickname.wise_recipients,
      matchType: 'nickname'
    };
  }

  // 2. Fuzzy name match on wise_recipients
  const { data: byName, error: nameError } = await supabase
    .from('wise_recipients')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .ilike('account_holder_name', `%${normalized}%`);

  if (nameError) {
    console.error('[RecipientMatcher] Name lookup error:', nameError.message);
    return { status: 'not_found' };
  }

  if (!byName || byName.length === 0) {
    return { status: 'not_found' };
  }

  if (byName.length === 1) {
    return {
      status: 'matched',
      recipient: byName[0],
      matchType: 'name'
    };
  }

  // Multiple matches — need disambiguation
  return {
    status: 'multiple',
    matches: byName,
    matchType: 'name'
  };
}

module.exports = { matchRecipient };
