import { ConflictException } from '@nestjs/common';
import { mapLastAdmin, mapLockError } from '@/modules/org/orgs/org-lock';

function conflictBody(fn: () => never): unknown {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    return (error as ConflictException).getResponse();
  }
  throw new Error('did not throw');
}

describe('mapLockError (item 12, round 2 item 9)', () => {
  it.each(['40P01', '55P03'])(
    'maps %s (deadlock, lock timeout) to 409 retry',
    (code) => {
      expect(conflictBody(() => mapLockError({ code }))).toEqual({
        statusCode: 409,
        message: expect.any(String),
        code: 'retry',
      });
      // TypeORM QueryFailedError carries it on driverError
      expect(
        conflictBody(() => mapLockError({ driverError: { code } })),
      ).toMatchObject({ code: 'retry' });
    },
  );

  it('rethrows anything else unchanged, the last-admin trigger included', () => {
    const trigger = { code: '23514', constraint: 'members_keep_one_admin' };
    expect(() => mapLockError(trigger)).toThrow(
      expect.objectContaining(trigger) as unknown as Error,
    );
  });
});

describe('mapLastAdmin (item 12)', () => {
  it.each(['40P01', '55P03'])('rethrows %s unchanged', (code) => {
    expect(() => mapLastAdmin({ code })).toThrow(
      expect.objectContaining({ code }) as unknown as Error,
    );
  });

  it("maps only the trigger's check_violation to last_admin", () => {
    expect(
      conflictBody(() =>
        mapLastAdmin({ code: '23514', constraint: 'members_keep_one_admin' }),
      ),
    ).toMatchObject({ code: 'last_admin' });
  });

  it('rethrows anything else unchanged', () => {
    const other = { code: '23514', constraint: 'another_check' };
    expect(() => mapLastAdmin(other)).toThrow(
      expect.objectContaining(other) as unknown as Error,
    );
    const plain = new Error('boom');
    expect(() => mapLastAdmin(plain)).toThrow(plain);
  });
});
