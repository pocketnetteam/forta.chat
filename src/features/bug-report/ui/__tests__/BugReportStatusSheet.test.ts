// @vitest-environment happy-dom
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
  vi.stubEnv('VITE_BUG_REPORT_ENDPOINT', 'https://bugs.test');
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
    trackCreatedIssue('addr-1', { number: 100, title: '[android] bug A', manageKey: 'k', url: 'https://github.com/o/r/issues/100' });
    trackCreatedIssue('addr-1', { number: 101, title: '[android] bug B', manageKey: 'k', url: 'https://github.com/o/r/issues/101' });
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
    trackCreatedIssue('addr-2', { number: 1, title: 'open-one', manageKey: 'k', url: 'https://github.com/o/r/issues/1' });
    trackCreatedIssue('addr-2', { number: 2, title: 'closed-one', manageKey: 'k', url: 'https://github.com/o/r/issues/2' });
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

  it('shows a report sent before the proxy without close or reopen buttons (audit S10-06)', async () => {
    localStorage.setItem(
      'forta-chat:bug-report-mine:addr-3',
      JSON.stringify([{ number: 7, title: 'old', createdAt: '2026-01-01T00:00:00Z', lastKnownState: 'open' }]),
    );
    trackCreatedIssue('addr-3', { number: 8, title: 'new', manageKey: 'k', url: '' });
    useBugReportStatus().loadAllIssues('addr-3');

    const wrapper = mount(BugReportStatusSheet, {
      ...mountOpts,
      props: { show: true, address: 'addr-3', mode: 'manage' },
    });
    await flushPromises();

    const [newCard, oldCard] = wrapper.findAll('li');
    expect(newCard.text()).toContain('#8');
    expect(newCard.findAll('button')).toHaveLength(1);
    // A private repository gives no link: the reporter could not open it.
    expect(newCard.find('a').exists()).toBe(false);
    expect(oldCard.text()).toContain('#7');
    expect(oldCard.findAll('button')).toHaveLength(0);
    expect(oldCard.find('a').attributes('href')).toBe('https://github.com/greenShirtMystery/forta-bugs/issues/7');
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
