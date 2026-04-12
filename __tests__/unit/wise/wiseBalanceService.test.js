/**
 * WiseBalanceService Tests
 * Tests for fetching account balances from Wise API
 */

import WiseBalanceService from '../../../services/wise/wiseBalanceService';

describe('WiseBalanceService', () => {
  let service;
  let mockClient;
  let mockSupabase;

  const mockBalancesResponse = [
    {
      id: 12345,
      currency: 'USD',
      type: 'STANDARD',
      amount: {
        value: 24850.00,
        currency: 'USD',
      },
      reservedAmount: {
        value: 0,
        currency: 'USD',
      },
      cashAmount: null,
      totalWorth: {
        value: 24850.00,
        currency: 'USD',
      },
    },
    {
      id: 12346,
      currency: 'EUR',
      type: 'STANDARD',
      amount: {
        value: 1250.50,
        currency: 'EUR',
      },
      reservedAmount: {
        value: 0,
        currency: 'EUR',
      },
      cashAmount: null,
      totalWorth: {
        value: 1250.50,
        currency: 'EUR',
      },
    },
  ];

  beforeEach(() => {
    mockClient = {
      profileId: '12345',
      get: jest.fn().mockResolvedValue(mockBalancesResponse),
    };

    mockSupabase = {
      from: jest.fn(() => ({
        insert: jest.fn(() => ({
          error: null,
        })),
      })),
    };

    service = new WiseBalanceService(mockClient, mockSupabase);
  });

  describe('getBalances', () => {
    it('should fetch all balances successfully', async () => {
      const result = await service.getBalances({ userId: 'user-123' });

      expect(mockClient.get).toHaveBeenCalledWith(
        '/v4/profiles/12345/balances?types=STANDARD'
      );
      expect(result).toEqual(mockBalancesResponse);
      expect(result).toHaveLength(2);
    });

    it('should call Wise API with correct profile ID', async () => {
      await service.getBalances({ userId: 'user-123' });

      expect(mockClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/v4/profiles/12345/balances')
      );
    });

    it('should log balance check to database', async () => {
      await service.getBalances({ userId: 'user-123' });

      expect(mockSupabase.from).toHaveBeenCalledWith('wise_balance_checks');
    });

    it('should handle API errors', async () => {
      mockClient.get.mockRejectedValue(new Error('API Error'));

      await expect(
        service.getBalances({ userId: 'user-123' })
      ).rejects.toThrow('Failed to fetch balances: API Error');
    });

    it('should handle missing userId gracefully', async () => {
      const result = await service.getBalances({ userId: null });

      expect(result).toEqual(mockBalancesResponse);
      // Should still fetch balances even without userId
    });

    it('should continue on database logging failure', async () => {
      mockSupabase.from = jest.fn(() => ({
        insert: jest.fn(() => ({
          error: { message: 'DB error' },
        })),
      }));

      // Should not throw, just log warning
      const result = await service.getBalances({ userId: 'user-123' });
      expect(result).toEqual(mockBalancesResponse);
    });
  });

  describe('getBalanceByCurrency', () => {
    it('should fetch USD balance successfully', async () => {
      const result = await service.getBalanceByCurrency({
        userId: 'user-123',
        currency: 'USD',
      });

      expect(result).toEqual({
        currency: 'USD',
        amount: 24850.00,
        available: 24850.00,
        reserved: 0,
      });
    });

    it('should fetch EUR balance successfully', async () => {
      const result = await service.getBalanceByCurrency({
        userId: 'user-123',
        currency: 'EUR',
      });

      expect(result).toEqual({
        currency: 'EUR',
        amount: 1250.50,
        available: 1250.50,
        reserved: 0,
      });
    });

    it('should default to USD if currency not specified', async () => {
      const result = await service.getBalanceByCurrency({
        userId: 'user-123',
      });

      expect(result.currency).toBe('USD');
      expect(result.amount).toBe(24850.00);
    });

    it('should return zero balance for non-existent currency', async () => {
      const result = await service.getBalanceByCurrency({
        userId: 'user-123',
        currency: 'GBP',
      });

      expect(result).toEqual({
        currency: 'GBP',
        amount: 0,
        available: 0,
        reserved: 0,
      });
    });

    it('should handle reserved amounts correctly', async () => {
      const balancesWithReserved = [
        {
          currency: 'USD',
          amount: {
            value: 1000.00,
            currency: 'USD',
            reserved: 100.00,
          },
        },
      ];

      mockClient.get.mockResolvedValue(balancesWithReserved);

      const result = await service.getBalanceByCurrency({
        userId: 'user-123',
        currency: 'USD',
      });

      expect(result.reserved).toBe(100.00);
    });

    it('should call getBalances internally', async () => {
      const getBalancesSpy = jest.spyOn(service, 'getBalances');

      await service.getBalanceByCurrency({
        userId: 'user-123',
        currency: 'USD',
      });

      expect(getBalancesSpy).toHaveBeenCalledWith({ userId: 'user-123' });
    });
  });

  describe('_logBalanceCheck', () => {
    it('should log balance check with correct data', async () => {
      const insertMock = jest.fn(() => ({ error: null }));
      mockSupabase.from = jest.fn(() => ({
        insert: insertMock,
      }));

      await service._logBalanceCheck('user-123', mockBalancesResponse);

      expect(mockSupabase.from).toHaveBeenCalledWith('wise_balance_checks');
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-123',
          profile_id: '12345',
          balances: mockBalancesResponse,
          checked_at: expect.any(String),
        })
      );
    });

    it('should not throw on database errors', async () => {
      mockSupabase.from = jest.fn(() => ({
        insert: jest.fn(() => ({
          error: { message: 'DB error' },
        })),
      }));

      // Should not throw
      await expect(
        service._logBalanceCheck('user-123', mockBalancesResponse)
      ).resolves.not.toThrow();
    });

    it('should handle missing database gracefully', async () => {
      const serviceWithoutDb = new WiseBalanceService(mockClient, null);

      // Should not throw when db is null
      await expect(
        serviceWithoutDb._logBalanceCheck('user-123', mockBalancesResponse)
      ).resolves.not.toThrow();
    });
  });

  describe('Error scenarios', () => {
    it('should handle network errors', async () => {
      mockClient.get.mockRejectedValue(new Error('Network timeout'));

      await expect(
        service.getBalances({ userId: 'user-123' })
      ).rejects.toThrow('Failed to fetch balances: Network timeout');
    });

    it('should handle 401 unauthorized', async () => {
      mockClient.get.mockRejectedValue(new Error('401 Unauthorized'));

      await expect(
        service.getBalances({ userId: 'user-123' })
      ).rejects.toThrow('Failed to fetch balances: 401 Unauthorized');
    });

    it('should handle 404 not found', async () => {
      mockClient.get.mockRejectedValue(new Error('404 Not Found'));

      await expect(
        service.getBalances({ userId: 'user-123' })
      ).rejects.toThrow('Failed to fetch balances: 404 Not Found');
    });

    it('should handle empty balances array', async () => {
      mockClient.get.mockResolvedValue([]);

      const result = await service.getBalances({ userId: 'user-123' });
      expect(result).toEqual([]);
    });

    it('should handle malformed balance data', async () => {
      const malformedData = [
        {
          currency: 'USD',
          // Missing amount field
        },
      ];

      mockClient.get.mockResolvedValue(malformedData);

      const result = await service.getBalanceByCurrency({
        userId: 'user-123',
        currency: 'USD',
      });

      // Should handle gracefully
      expect(result.currency).toBe('USD');
    });
  });

  describe('Integration scenarios', () => {
    it('should work with multiple balances', async () => {
      const result = await service.getBalances({ userId: 'user-123' });

      expect(result).toHaveLength(2);
      expect(result[0].currency).toBe('USD');
      expect(result[1].currency).toBe('EUR');
    });

    it('should filter currency correctly', async () => {
      const usdResult = await service.getBalanceByCurrency({
        userId: 'user-123',
        currency: 'USD',
      });

      const eurResult = await service.getBalanceByCurrency({
        userId: 'user-123',
        currency: 'EUR',
      });

      expect(usdResult.amount).toBe(24850.00);
      expect(eurResult.amount).toBe(1250.50);
      expect(usdResult.amount).not.toBe(eurResult.amount);
    });
  });
});
