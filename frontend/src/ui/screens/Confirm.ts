/** Modal confirmation dialog (restart / quit / reset). */
import { Panel, type ConfirmOptions, type UIContext } from '../core';
import { div, h } from '../dom';
import { button, icon } from '../widgets';

export class ConfirmDialog extends Panel {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly ok: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;
  private onConfirm: (() => void) | null = null;

  constructor(private readonly ctx: UIContext) {
    super();
    this.title = h('h3', { class: 'nb-confirm-title' });
    this.body = h('p', { class: 'nb-confirm-body' });
    this.cancel = button(ctx, { label: 'CANCEL', sound: 'back', onClick: () => ctx.pop() });
    this.ok = button(ctx, {
      label: 'CONFIRM',
      variant: 'primary',
      onClick: () => {
        const fn = this.onConfirm;
        this.onConfirm = null;
        ctx.pop();
        fn?.();
      },
    });
    this.el = h(
      'section',
      { class: 'nb-layer nb-panel nb-confirm', role: 'alertdialog', 'aria-modal': 'true' },
      div('nb-confirm-backdrop'),
      h('div', { class: 'nb-confirm-card' }, h('div', { class: 'nb-confirm-ico' }, icon('warning')), this.title, this.body, h('div', { class: 'nb-confirm-actions' }, this.cancel, this.ok)),
    );
  }

  prepare(o: ConfirmOptions, onConfirm: () => void): void {
    this.onConfirm = onConfirm;
    this.title.textContent = o.title;
    this.body.textContent = o.body;
    this.ok.querySelector('.nb-btn-label')!.textContent = o.confirmLabel;
    this.cancel.querySelector('.nb-btn-label')!.textContent = o.cancelLabel ?? 'CANCEL';
    this.ok.className = `nb-btn ${o.danger ? 'nb-btn-danger' : 'nb-btn-primary'}`;
    this.el.classList.toggle('is-danger', !!o.danger);
    this.lastFocus = null;
  }

  override defaultFocus(): HTMLElement | null {
    return this.cancel;
  }
}
