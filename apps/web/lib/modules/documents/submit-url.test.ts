// 提出先の URL（T24。D-62。04「提出物」の提出先）：リンクにしてよい形か。DB の documents_submit_url_check と同じ形（https で始まり、空白・
// 制御文字を含まない、500 字まで）だけを href に入れる。
import { describe, expect, it } from 'vitest';
import { isSubmitUrl, SUBMIT_URL_MAX, submitUrlHref } from './submit-url';

describe('T24 submitUrlHref', () => {
  it('https の URL はそのまま返す', () => {
    expect(submitUrlHref('https://drive.google.com/drive/folders/abc?usp=sharing')).toBe('https://drive.google.com/drive/folders/abc?usp=sharing');
    expect(submitUrlHref(`https://${'a'.repeat(SUBMIT_URL_MAX - 8)}`)).toHaveLength(500);
  });

  it('null・空・https でない・空白や制御文字を含む・長すぎるものはリンクにしない（null）', () => {
    for (const v of [null, undefined, '', 'http://x', 'javascript:alert(1)', 'data:text/html,x', 'https://', ' https://x', 'https://x y', 'https://x　', 'https://x\n', 'https://x\u0000']) {
      expect(submitUrlHref(v), String(v)).toBeNull();
    }
    expect(submitUrlHref(`https://${'a'.repeat(SUBMIT_URL_MAX - 7)}`)).toBeNull();
    expect(isSubmitUrl('https://forms.gle/a')).toBe(true);
  });
});
