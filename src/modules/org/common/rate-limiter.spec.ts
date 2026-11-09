import { ipBucket } from '@/modules/org/common/rate-limiter';

describe('ipBucket', () => {
  it.each(['203.0.113.7', '10.0.0.1'])('keeps IPv4 %s as is', (ip) =>
    expect(ipBucket(ip)).toBe(ip),
  );

  it('maps an IPv4-mapped IPv6 address to its IPv4 address', () =>
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7'));

  it.each([
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::9', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002:ffff::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['64:ff9b:1:2::192.0.2.1', '64:ff9b:1:2::/64'],
  ])('keys IPv6 %s by its /64 prefix', (ip, bucket) =>
    expect(ipBucket(ip)).toBe(bucket),
  );

  it('keeps a non-IP value (e.g. "unknown") as is', () =>
    expect(ipBucket('unknown')).toBe('unknown'));
});
