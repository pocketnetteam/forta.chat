import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import BugReportStatusSheet from '../BugReportStatusSheet.vue';
import { useBugReportStatus } from '../../model/use-bug-report-status';

// Stub the BottomSheet wrapper — we only care about the inner slot markup.
vi.mock('@/shared/ui/bottom-sheet/BottomSheet.vue', () => ({
  default: {
    name: 'BottomSheet',
    props: ['show', 'ariaLabel', 'height', 'dragDismiss'],
    emits: ['close'],
    template: '<div v-if="show" data-testid="sheet"><slot /></div>',
  },
}));

// Stub i18n + provide auto-import shim that BugReportStatusSheet.vue uses.
vi.stubGlobal('useI18n', () => ({ t: (k: string) => k }));

function flushPending() {
  return flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubEnv('VITE_BUG_REPORT_TOKEN', 'test-token');
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  // Re-stub useI18n because unstubAllGlobals removes it.
  vi.stubGlobal('useI18n', () => ({ t: (k: string) => k }));
});

describe('BugReportStatusSheet', () => {
  it('renders nothing visible when show=false', () => {
    const wrapper = mount(BugReportStatusSheet, {
      props: { show: false, address: 'addr-1' },
    });
    expect(wrapper.find('[data-testid="sheet"]').exists()).toBe(false);
  });

  it('renders a card per pending issue and resolves one on click', async () => {
    // Seed pendingIssues via the real composable.
    const status = useBugReportStatus();
    const { computeReporterHash, buildReporterMarker } = await import(
      '@/shared/lib/bug-report'
    );
    const marker = buildReporterMarker(await computeReporterHash('addr-1'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            items: [
              {
                number: 100,
                title: '[android] bug A',
                html_url: 'u100',
                state: 'closed',
                body: `${marker}\nbody`,
              },
              {
                number: 101,
                title: '[android] bug B',
                html_url: 'u101',
                state: 'closed',
                body: `${marker}\nbody`,
              },
            ],
          }),
      }),
    );
    await status.checkStatuses('addr-1');
    // Re-stub useI18n (unstub happened in prior afterEach could wipe; safe here).
    vi.stubGlobal('useI18n', () => ({ t: (k: string) => k }));

    const wrapper = mount(BugReportStatusSheet, {
      props: { show: true, address: 'addr-1' },
    });
    await flushPending();

    const cards = wrapper.findAll('li');
    expect(cards).toHaveLength(2);
    expect(cards[0].text()).toContain('#100');
    expect(cards[0].text()).toContain('bug A');

    // Click "resolved" on first card
    await cards[0].findAll('button')[0].trigger('click');
    await flushPending();

    expect(status.pendingIssues.value.map((i) => i.number)).toEqual([101]);
  });
});
