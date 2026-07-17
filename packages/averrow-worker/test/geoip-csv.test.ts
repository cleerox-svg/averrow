import { describe, it, expect } from 'vitest';
import {
  parseLocationsCsv,
  parseBlocksCsvChunk,
  cidrToIntRange,
} from '../src/lib/geoip-csv';

describe('cidrToIntRange', () => {
  it('handles a trivial /24', () => {
    expect(cidrToIntRange('1.0.0.0/24')).toEqual({ start: 16777216, end: 16777471 });
  });

  it('handles the full /0 range without 32-bit signed overflow', () => {
    expect(cidrToIntRange('0.0.0.0/0')).toEqual({ start: 0, end: 4294967295 });
  });

  it('handles a single-host /32 at the top of the IPv4 space', () => {
    expect(cidrToIntRange('255.255.255.255/32')).toEqual({
      start: 4294967295,
      end: 4294967295,
    });
  });

  it('handles a /16 in the high bit range (signed-overflow trap)', () => {
    // 192.168.0.0 = 0xC0A80000 = 3232235520. Bitwise & on this
    // returns negative; arithmetic must stay positive.
    expect(cidrToIntRange('192.168.0.0/16')).toEqual({
      start: 3232235520,
      end: 3232301055,
    });
  });

  it('returns null for malformed input', () => {
    expect(cidrToIntRange('foo')).toBeNull();
    expect(cidrToIntRange('1.2.3.4')).toBeNull();
    expect(cidrToIntRange('1.2.3.4/33')).toBeNull();
    expect(cidrToIntRange('256.0.0.0/24')).toBeNull();
    expect(cidrToIntRange('/24')).toBeNull();
  });
});

describe('parseLocationsCsv', () => {
  it('parses MaxMind locations format', () => {
    const csv = `geoname_id,locale_code,continent_code,continent_name,country_iso_code,country_name,subdivision_1_iso_code,subdivision_1_name,subdivision_2_iso_code,subdivision_2_name,city_name,metro_code,time_zone,is_in_european_union
5128581,en,NA,"North America",US,"United States",NY,"New York",,,New York,501,America/New_York,0
6173331,en,NA,"North America",CA,"Canada",ON,Ontario,,,Toronto,,America/Toronto,0`;
    const locs = parseLocationsCsv(csv);
    expect(locs.size).toBe(2);
    expect(locs.get('5128581')).toEqual({
      geonameId: '5128581',
      countryCode: 'US',
      countryName: 'United States',
      region: 'New York',
      city: 'New York',
    });
    expect(locs.get('6173331')?.city).toBe('Toronto');
    expect(locs.get('6173331')?.region).toBe('Ontario');
  });

  it('handles quoted strings with commas', () => {
    const csv = `geoname_id,locale_code,continent_code,continent_name,country_iso_code,country_name,subdivision_1_iso_code,subdivision_1_name,subdivision_2_iso_code,subdivision_2_name,city_name,metro_code,time_zone,is_in_european_union
1,en,EU,Europe,DE,Germany,BY,Bavaria,,,"Munich, Bayern",,Europe/Berlin,1`;
    const locs = parseLocationsCsv(csv);
    expect(locs.get('1')?.city).toBe('Munich, Bayern');
  });
});

describe('parseBlocksCsvChunk', () => {
  it('parses MaxMind blocks format with header', () => {
    const csv = `network,geoname_id,registered_country_geoname_id,represented_country_geoname_id,is_anonymous_proxy,is_satellite_provider,postal_code,latitude,longitude,accuracy_radius
1.0.0.0/24,2078025,2077456,,0,0,,-33.8678,151.2073,1000
8.8.8.0/24,5128581,6252001,,0,0,10001,40.7484,-73.9857,500
`;
    const { rows, residual } = parseBlocksCsvChunk(csv, true);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.network).toBe('1.0.0.0/24');
    expect(rows[0]?.lat).toBe(-33.8678);
    expect(rows[0]?.lng).toBe(151.2073);
    expect(rows[1]?.postalCode).toBe('10001');
    expect(residual).toBe('');
  });

  it('returns the residual partial line at chunk boundary', () => {
    const csv = `network,geoname_id,registered_country_geoname_id,represented_country_geoname_id,is_anonymous_proxy,is_satellite_provider,postal_code,latitude,longitude,accuracy_radius
1.0.0.0/24,2078025,2077456,,0,0,,-33.8678,151.2073,1000
2.0.0.0/24,5128581`;
    const { rows, residual } = parseBlocksCsvChunk(csv, true);
    expect(rows).toHaveLength(1);
    expect(residual).toBe('2.0.0.0/24,5128581');
  });

  it('handles empty lat/lng as null', () => {
    const csv = `network,geoname_id,registered_country_geoname_id,represented_country_geoname_id,is_anonymous_proxy,is_satellite_provider,postal_code,latitude,longitude,accuracy_radius
1.0.0.0/24,2078025,2077456,,0,0,,,,
`;
    const { rows } = parseBlocksCsvChunk(csv, true);
    expect(rows[0]?.lat).toBeNull();
    expect(rows[0]?.lng).toBeNull();
  });
});
