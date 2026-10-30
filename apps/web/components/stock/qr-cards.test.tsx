// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CARDS_PER_PAGE, QrCards } from './qr-cards';

const room = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name: `倉庫${n}`,
  building: 'E棟',
  kind: 'room' as const,
  floor: n,
});

afterEach(() => cleanup());

describe('QrCards（部屋に貼る QR のカード。設計 3.4・6 章）', () => {
  it('場所ごとに1枚。URL の文字は basePath つきの /stock/?room=<id>（年度を入れない）、QR は SVG', () => {
    const rooms = [room(1), room(2), room(3)];
    render(<QrCards rooms={rooms} origin="https://example.org" basePath="/GAapp" />);
    const cards = screen.getAllByTestId('qr-card');
    expect(cards).toHaveLength(3);
    expect(screen.getAllByTestId('qr-url').map((e) => e.textContent)).toEqual(rooms.map((r) => `https://example.org/GAapp/stock/?room=${r.id}`));
    for (const c of cards) expect(c.querySelector('svg')).not.toBeNull();
    expect(cards[0]!.textContent).toContain('倉庫1');
    expect(cards[0]!.textContent).toContain('E棟 1階');
    expect(cards[0]!.textContent).toContain('在庫入力（電波祭 総務）');
    expect(cards[0]!.textContent).toContain('Safari か Chrome で開いてください');
  });

  it('basePath なしなら origin の直下', () => {
    render(<QrCards rooms={[room(1)]} origin="http://localhost:3240" basePath="" />);
    expect(screen.getByTestId('qr-url').textContent).toBe(`http://localhost:3240/stock/?room=${room(1).id}`);
  });

  it('A4 ごとに 8 枚（2列×4段）で分ける', () => {
    const rooms = Array.from({ length: CARDS_PER_PAGE + 3 }, (_, i) => room(i + 1));
    render(<QrCards rooms={rooms} origin="http://localhost" basePath="" />);
    expect(screen.getAllByTestId('qr-card')).toHaveLength(11);
    const pages = screen.getByTestId('qr-pages').children;
    expect(pages).toHaveLength(2);
    expect(pages[0]!.querySelectorAll('[data-testid="qr-card"]')).toHaveLength(8);
    expect(pages[1]!.querySelectorAll('[data-testid="qr-card"]')).toHaveLength(3);
  });

  it('origin がまだない（プリレンダーの間）なら何も出さない', () => {
    const { container } = render(<QrCards rooms={[room(1)]} origin="" basePath="" />);
    expect(container.innerHTML).toBe('');
  });
});
