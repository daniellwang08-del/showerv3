import { describe, expect, it } from 'vitest';
import { jobSiteStatus, pumbleStatus, relativeTime, resumeLabel, sheetsStatus } from './status';
import { extensionStatusText, extensionSteps } from './useJobSiteConnect';
import { makeConnection, makePlugin } from './testUtils';

describe('integration status helpers', () => {
  it('derives exactly one job-site status', () => {
    const plugin = makePlugin();
    expect(jobSiteStatus(makePlugin({ connectable: false, unavailable_reason: 'Nope' }), undefined)).toEqual({
      kind: 'unavailable',
      detail: 'Nope',
    });
    expect(jobSiteStatus(plugin, undefined).kind).toBe('not_connected');
    expect(jobSiteStatus(plugin, makeConnection({ last_error: 'boom', enabled: false })).kind).toBe('attention');
    expect(jobSiteStatus(plugin, makeConnection({ enabled: false })).kind).toBe('off');
    expect(jobSiteStatus(plugin, makeConnection({ last_synced_at: null, last_listing_count: 1 }))).toEqual({
      kind: 'connected',
      detail: 'Not synced yet · 1 listing',
    });
  });

  it('maps lifecycle statuses to attention with a next step', () => {
    const plugin = makePlugin();
    const reauth = jobSiteStatus(plugin, makeConnection({ status: 'needs_reauth', last_error: 'Key rejected' }));
    expect(reauth).toEqual({ kind: 'attention', detail: 'Sign in again to resume syncing · Key rejected' });
    const soon = new Date(Date.now() + 3 * 3600_000).toISOString();
    expect(jobSiteStatus(plugin, makeConnection({ status: 'quota_exhausted', next_sync_at: soon }))).toEqual({
      kind: 'attention',
      detail: 'Request limit reached · resumes in 3h',
    });
    expect(
      jobSiteStatus(plugin, makeConnection({ status: 'quota_exhausted', next_sync_at: null, last_error: 'Key used up' })),
    ).toEqual({ kind: 'attention', detail: 'Request limit reached · Key used up' });
  });

  it('formats resume times', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(resumeLabel('2026-10-03T12:30:00', now)).toBe('in 30m');
    expect(resumeLabel('2026-10-03T12:00:30', now)).toBe('shortly');
    expect(resumeLabel(null, now)).toBeNull();
  });

  it('treats naive server timestamps as UTC', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(relativeTime('2026-10-03T10:00:00', now)).toBe('2h ago');
    expect(relativeTime('garbage', now)).toBeNull();
  });

  it('maps Sheets and Pumble configs to card status', () => {
    const status = { server_configured: true, service_account_email: 'a@b' };
    expect(sheetsStatus({ status: { ...status, server_configured: false }, config: { configured: true } }).kind).toBe('unavailable');
    expect(sheetsStatus({ status, config: { configured: false } }).kind).toBe('not_connected');
    expect(sheetsStatus({ status, config: { configured: true, assigned_tab_count: 0 } }).kind).toBe('attention');
    expect(sheetsStatus({ status, config: { configured: true, assigned_tab_count: 2, group_count: 1, is_enabled: false } }).kind).toBe('off');

    const dest = { id: '1', label: 'A', channel_id: 'c', channel_name: 'c', is_enabled: false };
    expect(pumbleStatus({ status: { integration_available: false }, config: { configured: false } }).kind).toBe('unavailable');
    expect(pumbleStatus({ status: { integration_available: true }, config: { configured: true, integrations: [dest] } }).kind).toBe('off');
    expect(
      pumbleStatus({ status: { integration_available: true }, config: { configured: true, integrations: [{ ...dest, is_enabled: true }] } }).detail,
    ).toBe('1 destination · score ≥ 75');
  });

  it('walks the extension connect steps', () => {
    expect(extensionSteps('idle', null, false)).toEqual(['active', 'pending', 'pending', 'pending']);
    expect(extensionSteps('need_extension', false, false)[0]).toBe('failed');
    expect(extensionSteps('navigating', true, false)).toEqual(['done', 'active', 'pending', 'pending']);
    expect(extensionSteps('signed_out', true, false)).toEqual(['done', 'done', 'active', 'pending']);
    expect(extensionSteps('connecting', true, true)).toEqual(['done', 'done', 'done', 'active']);
    expect(extensionSteps('cancelled', true, false)).toEqual(['done', 'failed', 'pending', 'pending']);
    expect(extensionStatusText('start_failed', 'Jobright')).toBe('The extension could not open Jobright. See the error below.');
  });
});
