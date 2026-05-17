/**
 * Unit tests for AgentPhone Client
 */

// Mock fetch globally
global.fetch = jest.fn();

// Mock environment variables
process.env.AGENTPHONE_API_KEY = 'test_api_key_123';
process.env.AGENTPHONE_AGENT_ID = 'test_agent_456';

const agentPhoneClient = require('../../../../services/agentphone/agentphoneClient');

describe('AgentPhoneClient', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    fetch.mockClear();
  });

  describe('Configuration', () => {
    it('should be configured with API key and agent ID', () => {
      expect(agentPhoneClient.isConfigured()).toBe(true);
    });

    it('should have API key and agent ID from environment', () => {
      expect(agentPhoneClient.apiKey).toBe('test_api_key_123');
      expect(agentPhoneClient.agentId).toBe('test_agent_456');
    });
  });

  describe('sendMessage()', () => {
    const mockPhoneNumber = '+1234567890';
    const mockMessage = 'Test message';
    const mockConversationId = 'conv_123';

    it('should send SMS message successfully', async () => {
      const mockResponse = {
        id: 'msg_123',
        conversation_id: 'conv_456',
        status: 'sent',
        created_at: '2026-05-17T12:00:00Z'
      };

      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      const result = await agentPhoneClient.sendMessage(
        mockPhoneNumber,
        mockMessage,
        mockConversationId
      );

      expect(result).toEqual({
        success: true,
        messageId: 'msg_123',
        conversationId: 'conv_456',
        status: 'sent',
        timestamp: '2026-05-17T12:00:00Z'
      });

      expect(fetch).toHaveBeenCalledWith(
        'https://api.agentphone.ai/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Authorization': 'Bearer test_api_key_123',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            agent_id: 'test_agent_456',
            to: mockPhoneNumber,
            body: mockMessage,
            channel: 'sms',
            conversation_id: mockConversationId
          })
        })
      );
    });

    it('should send message without conversation ID', async () => {
      const mockResponse = {
        id: 'msg_789',
        conversation_id: 'conv_new',
        status: 'sent',
        created_at: '2026-05-17T12:00:00Z'
      };

      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      await agentPhoneClient.sendMessage(mockPhoneNumber, mockMessage);

      const callBody = JSON.parse(fetch.mock.calls[0][1].body);
      expect(callBody).not.toHaveProperty('conversation_id');
    });

    it('should reject invalid phone number format', async () => {
      await expect(
        agentPhoneClient.sendMessage('123456', 'Test')
      ).rejects.toThrow('Invalid phone number format');

      await expect(
        agentPhoneClient.sendMessage('invalid', 'Test')
      ).rejects.toThrow('Invalid phone number format');
    });

    it('should require phone number and message', async () => {
      await expect(
        agentPhoneClient.sendMessage('', 'Test')
      ).rejects.toThrow('Phone number and message are required');

      await expect(
        agentPhoneClient.sendMessage(mockPhoneNumber, '')
      ).rejects.toThrow('Phone number and message are required');
    });

    it('should handle API errors', async () => {
      fetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ message: 'Invalid API key' })
      });

      await expect(
        agentPhoneClient.sendMessage(mockPhoneNumber, mockMessage)
      ).rejects.toThrow('AgentPhone API error: 401 - Invalid API key');
    });

    it('should handle network errors', async () => {
      fetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        agentPhoneClient.sendMessage(mockPhoneNumber, mockMessage)
      ).rejects.toThrow('Network error');
    });
  });

  describe('getConversation()', () => {
    const mockConversationId = 'conv_123';

    it('should fetch conversation history', async () => {
      const mockMessages = [
        { id: 'msg_1', body: 'Hello', direction: 'inbound' },
        { id: 'msg_2', body: 'Hi there', direction: 'outbound' }
      ];

      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: mockMessages })
      });

      const result = await agentPhoneClient.getConversation(mockConversationId);

      expect(result).toEqual(mockMessages);
      expect(fetch).toHaveBeenCalledWith(
        `https://api.agentphone.ai/v1/conversations/${mockConversationId}`,
        expect.objectContaining({
          headers: {
            'Authorization': 'Bearer test_api_key_123',
            'Content-Type': 'application/json'
          }
        })
      );
    });

    it('should require conversation ID', async () => {
      await expect(
        agentPhoneClient.getConversation()
      ).rejects.toThrow('Conversation ID is required');
    });

    it('should handle API errors', async () => {
      fetch.mockResolvedValueOnce({
        ok: false,
        status: 404
      });

      await expect(
        agentPhoneClient.getConversation(mockConversationId)
      ).rejects.toThrow('Failed to fetch conversation: 404');
    });
  });

  describe('E.164 Phone Number Validation', () => {
    const validNumbers = [
      '+1234567890',      // US/Canada
      '+447911123456',    // UK
      '+919876543210',    // India
      '+8613800138000'    // China
    ];

    const invalidNumbers = [
      '1234567890',       // Missing +
      '+0123456789',      // Starts with 0
      '+1',               // Too short
      '+123456789012345678', // Too long
      'phone',            // Not a number
      '+1-234-567-8900'   // Has formatting
    ];

    validNumbers.forEach(number => {
      it(`should accept valid E.164 number: ${number}`, async () => {
        fetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'msg_test', status: 'sent' })
        });

        await expect(
          agentPhoneClient.sendMessage(number, 'Test')
        ).resolves.toBeTruthy();
      });
    });

    invalidNumbers.forEach(number => {
      it(`should reject invalid E.164 number: ${number}`, async () => {
        await expect(
          agentPhoneClient.sendMessage(number, 'Test')
        ).rejects.toThrow('Invalid phone number format');
      });
    });
  });
});
