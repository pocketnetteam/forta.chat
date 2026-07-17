import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import VideoTile from '../VideoTile.vue';

vi.stubGlobal('useI18n', () => ({ t: (k: string) => k }));

// UserAvatar is auto-imported; stub it so tests don't need the full auth module.
vi.mock('@/entities/user', () => ({
  UserAvatar: { name: 'UserAvatar', template: '<div class="mock-avatar" />' },
}));

describe('VideoTile', () => {
  beforeEach(() => {
    vi.stubGlobal('useI18n', () => ({ t: (k: string) => k }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('useI18n', () => ({ t: (k: string) => k }));
  });

  it('applies object-contain class when objectFit is "contain"', () => {
    const wrapper = mount(VideoTile, {
      props: {
        stream: null,
        objectFit: 'contain',
      },
    });
    const video = wrapper.find('video');
    expect(video.exists()).toBe(true);
    expect(video.classes()).toContain('object-contain');
    expect(video.classes()).not.toContain('object-cover');
  });

  it('applies object-cover class when objectFit is "cover"', () => {
    const wrapper = mount(VideoTile, {
      props: {
        stream: null,
        objectFit: 'cover',
      },
    });
    const video = wrapper.find('video');
    expect(video.classes()).toContain('object-cover');
    expect(video.classes()).not.toContain('object-contain');
  });

  it('mirrors the video when mirror prop is true (local self-view)', () => {
    const wrapper = mount(VideoTile, {
      props: {
        stream: null,
        mirror: true,
      },
    });
    const video = wrapper.find('video');
    expect(video.classes()).toContain('scale-x-[-1]');
  });

  it('does not mirror when mirror is false', () => {
    const wrapper = mount(VideoTile, {
      props: {
        stream: null,
        mirror: false,
      },
    });
    const video = wrapper.find('video');
    expect(video.classes()).not.toContain('scale-x-[-1]');
  });

  it('emits aspectchange with the natural ratio on loadedmetadata (WEE-53 self-preview)', async () => {
    const wrapper = mount(VideoTile, {
      props: { stream: null, objectFit: 'cover' },
    });
    const video = wrapper.find('video');
    // happy-dom leaves videoWidth/Height at 0; stub a portrait 9:16 source.
    Object.defineProperty(video.element, 'videoWidth', { value: 720, configurable: true });
    Object.defineProperty(video.element, 'videoHeight', { value: 1280, configurable: true });

    await video.trigger('loadedmetadata');

    const events = wrapper.emitted('aspectchange');
    expect(events).toBeTruthy();
    expect(events?.[0]?.[0]).toBeCloseTo(720 / 1280);
  });

  it('does not emit aspectchange while dimensions are still zero', async () => {
    const wrapper = mount(VideoTile, {
      props: { stream: null, objectFit: 'cover' },
    });
    const video = wrapper.find('video');
    // videoWidth/Height default to 0 in happy-dom — no usable aspect yet.
    await video.trigger('loadedmetadata');
    expect(wrapper.emitted('aspectchange')).toBeFalsy();
  });

  it('does not re-emit on stream swap — prior aspect persists until next loadedmetadata', async () => {
    // Contract lock (WEE-53 review): swapping the stream must NOT emit a
    // reset. A parent keeps the last reported ratio until the new stream's
    // metadata arrives, avoiding a size blip on every camera flip.
    const wrapper = mount(VideoTile, {
      props: { stream: new MediaStream(), objectFit: 'cover' },
    });
    const video = wrapper.find('video');
    Object.defineProperty(video.element, 'videoWidth', { value: 1280, configurable: true });
    Object.defineProperty(video.element, 'videoHeight', { value: 720, configurable: true });
    await video.trigger('loadedmetadata');
    expect(wrapper.emitted('aspectchange')).toHaveLength(1);

    // Swap to a different stream — no metadata event yet.
    await wrapper.setProps({ stream: new MediaStream() });
    // Still exactly one emit: the swap itself emitted nothing.
    expect(wrapper.emitted('aspectchange')).toHaveLength(1);
  });
});
