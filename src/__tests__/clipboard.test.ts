/** Verifies clipboard resolution order and the no-clipboard fallback. */
describe('clipboard resolution', () => {
  beforeEach(() => jest.resetModules());

  it('prefers the community package when installed', () => {
    const setString = jest.fn();
    jest.doMock('@react-native-clipboard/clipboard', () => ({
      default: { setString },
    }));
    const { resolveCopy, canCopy } = require('../../src/clipboard');
    expect(canCopy).toBe(true);
    resolveCopy()!('hi');
    expect(setString).toHaveBeenCalledWith('hi');
  });

  it('falls back to react-native core Clipboard', () => {
    const setString = jest.fn();
    jest.doMock('@react-native-clipboard/clipboard', () => {
      throw new Error('not installed');
    });
    jest.doMock('react-native', () => ({ Clipboard: { setString } }));
    const { resolveCopy, canCopy } = require('../../src/clipboard');
    expect(canCopy).toBe(true);
    resolveCopy()!('yo');
    expect(setString).toHaveBeenCalledWith('yo');
  });

  it('returns undefined when neither is available', () => {
    jest.doMock('@react-native-clipboard/clipboard', () => {
      throw new Error('nope');
    });
    jest.doMock('react-native', () => ({}));
    const { resolveCopy, canCopy } = require('../../src/clipboard');
    expect(canCopy).toBe(false);
    expect(resolveCopy()).toBeUndefined();
  });

  it('an explicit override always wins', () => {
    const setString = jest.fn();
    const override = jest.fn();
    jest.doMock('@react-native-clipboard/clipboard', () => ({
      default: { setString },
    }));
    const { resolveCopy } = require('../../src/clipboard');
    resolveCopy(override)!('x');
    expect(override).toHaveBeenCalledWith('x');
    expect(setString).not.toHaveBeenCalled();
  });
});
