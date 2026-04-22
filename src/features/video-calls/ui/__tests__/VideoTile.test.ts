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
});
