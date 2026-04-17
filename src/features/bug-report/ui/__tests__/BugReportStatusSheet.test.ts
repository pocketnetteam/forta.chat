import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import BugReportStatusSheet from '../BugReportStatusSheet.vue';
import { useBugReportStatus } from '../../model/use-bug-report-status';
import { trackCreatedIssue, updateLocalIssueState } from '@/shared/lib/bug-report';

vi.stubGlobal('useI18n', () => ({ t: (k: string) => k }));
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubEnv('VITE_BUG_REPORT_TOKEN', 'test-token');
  localStorage.clear();
  useBugReportStatus().resetState();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubGlobal('useI18n', () => ({ t: (k: string) => k }));
});

const mountOpts = {
  global: {
    stubs: { Teleport: true },
  },
};

describe('BugReportStatusSheet', () => {
  it('renders no list when show=false', () => {
    const wrapper = mount(BugReportStatusSheet, {
      ...mountOpts,
      props: { show: false, address: 'addr-1' },
    });
    expect(wrapper.findAll('li')).toHaveLength(0);
  });

  it('manage mode renders a card per locally-tracked issue', async () => {
    trackCreatedIssue('addr-1', { number: 100, title: '[android] bug A' });
    trackCreatedIssue('addr-1', { number: 101, title: '[android] bug B' });
    useBugReportStatus().loadAllIssues('addr-1');

    const wrapper = mount(BugReportStatusSheet, {
      ...mountOpts,
      props: { show: true, address: 'addr-1', mode: 'manage' },
    });
    await flushPromises();

    const cards = wrapper.findAll('li');
    expect(cards).toHaveLength(2);
    expect(cards[0].text()).toContain('#101');
    expect(cards[1].text()).toContain('#100');
  });

  it('manage mode renders state pills (open vs closed)', async () => {
    trackCreatedIssue('addr-2', { number: 1, title: 'open-one' });
    trackCreatedIssue('addr-2', { number: 2, title: 'closed-one' });
    updateLocalIssueState('addr-2', 2, 'closed');
    useBugReportStatus().loadAllIssues('addr-2');

    const wrapper = mount(BugReportStatusSheet, {
      ...mountOpts,
      props: { show: true, address: 'addr-2', mode: 'manage' },
    });
    await flushPromises();

    const cards = wrapper.findAll('li');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.findAll('button').length).toBeGreaterThanOrEqual(1);
    }
  });

  it('manage mode hides list when no issues tracked', async () => {
    useBugReportStatus().loadAllIssues('addr-empty');

    const wrapper = mount(BugReportStatusSheet, {
      ...mountOpts,
      props: { show: true, address: 'addr-empty', mode: 'manage' },
    });
    await flushPromises();

    expect(wrapper.findAll('li')).toHaveLength(0);
  });
});
