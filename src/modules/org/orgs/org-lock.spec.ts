import { ConflictException } from '@nestjs/common';
import { mapLastAdmin } from '@/modules/org/orgs/org-lock';

function conflictBody(fn: () => never): unknown {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    return (error as ConflictException).getResponse();
  }
  throw new Error('did not throw');
}

describe('mapLastAdmin (item 12)', () => {
  it.each(['40P01', '55P03'])(
    'maps %s (deadlock, lock timeout) to 409 retry, not last_admin',
    (code) => {
      expect(conflictBody(() => mapLastAdmin({ code }))).toEqual({
        statusCode: 409,
        message: expect.any(String),
        code: 'retry',
      });
      // TypeORM QueryFailedError carries it on driverError
      expect(
        conflictBody(() => mapLastAdmin({ driverError: { code } })),
      ).toMatchObject({ code: 'retry' });
    },
  );

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
