/**
 * AgentPhone Client Service
 *
 * Handles communication with AgentPhone API for SMS functionality.
 * API Documentation: https://docs.agentphone.ai
 */

const AGENTPHONE_API_BASE = 'https://api.agentphone.ai/v1';

class AgentPhoneClient {
  constructor() {
    this.apiKey = process.env.AGENTPHONE_API_KEY;
    this.agentId = process.env.AGENTPHONE_AGENT_ID;

    if (!this.apiKey) {
      console.warn('[AgentPhoneClient] AGENTPHONE_API_KEY not configured');
    }
    if (!this.agentId) {
      console.warn('[AgentPhoneClient] AGENTPHONE_AGENT_ID not configured');
    }
  }

  /**
   * Send an SMS message to a phone number
   * @param {string} phoneNumber - E.164 format phone number (e.g., +1234567890)
   * @param {string} message - Message text to send
   * @param {string} conversationId - Optional AgentPhone conversation ID
   * @returns {Promise<Object>} Response with message ID and status
   */
  async sendMessage(phoneNumber, message, conversationId = null) {
    if (!this.apiKey || !this.agentId) {
      throw new Error('AgentPhone credentials not configured');
    }

    if (!phoneNumber || !message) {
      throw new Error('Phone number and message are required');
    }

    // Validate E.164 format
    if (!phoneNumber.match(/^\+[1-9]\d{1,14}$/)) {
      throw new Error(`Invalid phone number format: ${phoneNumber}. Must be E.164 format (e.g., +1234567890)`);
    }

    try {
      console.log('[AgentPhoneClient] Sending message to', phoneNumber);

      const payload = {
        agent_id: this.agentId,
        to: phoneNumber,
        body: message,
        channel: 'sms'
      };

      // Include conversation ID if provided (for threaded conversations)
      if (conversationId) {
        payload.conversation_id = conversationId;
      }

      const response = await fetch(`${AGENTPHONE_API_BASE}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `AgentPhone API error: ${response.status} - ${errorData.message || response.statusText}`
        );
      }

      const data = await response.json();

      console.log('[AgentPhoneClient] Message sent successfully:', data.id);

      return {
        success: true,
        messageId: data.id,
        conversationId: data.conversation_id,
        status: data.status,
        timestamp: data.created_at
      };
    } catch (error) {
      console.error('[AgentPhoneClient] Send message error:', error.message);
      throw error;
    }
  }

  /**
   * Get conversation history
   * @param {string} conversationId - AgentPhone conversation ID
   * @returns {Promise<Array>} Array of messages in the conversation
   */
  async getConversation(conversationId) {
    if (!this.apiKey) {
      throw new Error('AgentPhone API key not configured');
    }

    if (!conversationId) {
      throw new Error('Conversation ID is required');
    }

    try {
      const response = await fetch(
        `${AGENTPHONE_API_BASE}/conversations/${conversationId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch conversation: ${response.status}`);
      }

      const data = await response.json();
      return data.messages || [];
    } catch (error) {
      console.error('[AgentPhoneClient] Get conversation error:', error.message);
      throw error;
    }
  }

  /**
   * Check if client is properly configured
   * @returns {boolean} True if API key and agent ID are set
   */
  isConfigured() {
    return !!(this.apiKey && this.agentId);
  }
}

// Export singleton instance
const agentPhoneClient = new AgentPhoneClient();

module.exports = agentPhoneClient;
