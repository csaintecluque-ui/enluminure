// Enluminure — fenêtres, messages, menus
import { el } from './util.js';

export const $ = (s, r = document) => r.querySelector(s);

// ——— Message en bas de l'écran ———
let toastTimer = 0;
export function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export const modalOpen = () => !!document.querySelector('.modal-overlay');

/**
 * Fenêtre modale. `onSubmit` peut renvoyer false pour garder la fenêtre ouverte.
 * Résout avec la valeur du bouton choisi (null si annulé).
 */
export function openDialog({ title, body, buttons, onSubmit, wide = false, className = '' }) {
  buttons = buttons || [{ label: 'Annuler', value: null }, { label: 'OK', primary: true }];
  return new Promise(resolve => {
    const overlay = el('div', { class: 'modal-overlay' });
    const form = el('form', { class: `modal ${wide ? 'wide' : ''} ${className}`, novalidate: true });
    let done = false;
    const close = (v) => {
      if (done) return; done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
    };
    const actions = el('div', { class: 'modal-actions' },
      buttons.map(b => el('button', {
        type: b.primary ? 'submit' : 'button',
        class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
        onclick: b.primary ? null : () => close(b.value ?? null),
      }, b.label)));
    form.append(el('h2', {}, title), el('div', { class: 'modal-body' }, body), actions);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const primary = buttons.find(b => b.primary);
      if (onSubmit) {
        const r = await onSubmit();
        if (r === false) return;
        close(r === undefined ? (primary?.value ?? true) : r);
      } else close(primary?.value ?? true);
    });
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(null); });
    overlay.append(form);
    $('#modal-root').append(overlay);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => {
      const f = form.querySelector('input:not([type=hidden]):not([disabled]), select');
      if (f && !matchMedia('(pointer: coarse)').matches) { f.focus(); f.select?.(); }
      else form.querySelector('button.primary')?.focus();
    });
  });
}

export function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return openDialog({
    title,
    body: el('p', {}, text),
    buttons: [{ label: 'Annuler', value: false }, { label: okLabel, primary: true, value: true, danger }],
  });
}

export function field(label, input, hint) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), input, hint ? el('small', {}, hint) : null);
}

// ——— Barre de menus ———
export class MenuBar {
  constructor(container, menus, app) {
    this.app = app;
    this.menus = menus;
    this.container = container;
    this.openIndex = -1;
    this.drop = null;
    menus.forEach((m, i) => {
      const b = el('button', { class: 'menu-title', type: 'button', 'data-i': i }, m.label);
      b.addEventListener('click', (e) => { e.stopPropagation(); this.openIndex === i ? this.close() : this.open(i); });
      b.addEventListener('pointerenter', (e) => { if (this.openIndex >= 0 && this.openIndex !== i && e.pointerType === 'mouse') this.open(i); });
      container.append(b);
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.drop && !this.drop.contains(e.target) && !container.contains(e.target)) this.close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.drop) this.close(); });
    window.addEventListener('resize', () => this.close());
  }

  open(i) {
    this.close();
    this.openIndex = i;
    const btn = this.container.children[i];
    btn.classList.add('open');
    const drop = el('div', { class: 'menu-drop', role: 'menu' });
    for (const it of this.menus[i].items) {
      if (it === '-') { drop.append(el('div', { class: 'menu-sep' })); continue; }
      if (it.heading) { drop.append(el('div', { class: 'menu-heading' }, it.heading)); continue; }
      const act = this.app.actions[it.action];
      const enabled = act && (!act.enabled || act.enabled());
      const checked = act?.checked?.();
      const row = el('button', {
        type: 'button', class: `menu-item ${checked ? 'checked' : ''}`, disabled: !enabled, role: 'menuitem',
      }, el('span', { class: 'mi-check' }, checked ? '✓' : ''), el('span', { class: 'mi-label' }, it.label), el('span', { class: 'mi-key' }, it.key || ''));
      row.addEventListener('click', () => { this.close(); this.app.run(it.action); });
      drop.append(row);
    }
    document.body.append(drop);
    const r = btn.getBoundingClientRect();
    const w = drop.offsetWidth;
    drop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - w - 4))}px`;
    drop.style.top = `${r.bottom + 2}px`;
    drop.style.maxHeight = `${innerHeight - r.bottom - 12}px`;
    this.drop = drop;
  }

  close() {
    if (this.drop) { this.drop.remove(); this.drop = null; }
    if (this.openIndex >= 0) this.container.children[this.openIndex]?.classList.remove('open');
    this.openIndex = -1;
  }
}
