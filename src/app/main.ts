import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';
import { managedStorage } from '../storage';
import { Service, errorMessage } from '../service';
import { run } from '../system';
import { AppController, AuthorizationCancelled, type AppAction, type AppModel } from './controller';
import { nativeRun, nativeRender, nativeAction, nativeAuthorize, nativeAuthorizationResult, nativeAlert, nativeClosing, nativeMainThread } from './native';

function render(model: AppModel) {
  const status = model.status === 'running' ? 1 : model.status === 'paused' ? 2 : 0;
  nativeRender(status, model.version, model.busy, model.loaded, model.canStart, model.canUpgrade, model.upgradeLabel);
}

async function engine(demo: boolean, check = false) {
  if (demo) {
    let running = true, busy = false;
    const show = (label = 'Upgrade') => render({ status: running ? 'running' : 'paused', version: 'Preview', busy, loaded: running, canStart: true, canUpgrade: true, upgradeLabel: label });
    show();
    while (!nativeClosing()) {
      const action = nativeAction();
      if (action === 1 || action === 2) { running = action === 1; show(); }
      if (action === 3) {
        busy = true;
        for (let percent = 0; percent <= 100 && !nativeClosing(); percent += 5) { show(`Upgrading (${percent}%)`); await sleep(250); }
        busy = false; show();
      }
      await sleep(50);
    }
    return;
  }
  const storage = await managedStorage();
  if (storage.legacy) throw new Error('Migrate sbm with the CLI before using the menu bar app.');
  let pending: { resolve: (code: number) => void; reject: (error: Error) => void } | undefined;
  const authorize = (action: AppAction, directory: string): Promise<number> => {
    if (pending) throw new Error('Another authorization is pending.');
    return new Promise<number>((resolve, reject) => {
      pending = { resolve, reject };
      nativeAuthorize(action === 'start' ? 1 : action === 'pause' ? 2 : 3, directory);
    });
  };
  const controller = new AppController(new Service(storage.paths, run), storage.owner, authorize, render, (message, error) => nativeAlert(message, error));
  await controller.refresh();
  if (check) { controller.alert('Native alert callback check.', false); return; }
  let lastRefresh = Date.now();
  while (!nativeClosing()) {
    nativeAuthorizationResult((code, message) => {
      const request = pending;
      if (!request) return;
      pending = undefined;
      if (code === 1) request.resolve(0);
      else request.reject(code === 2 ? new AuthorizationCancelled() : new Error(message || 'Administrator authorization failed.'));
    });
    const action = nativeAction();
    if (action === 1 || action === 2) void controller.changeState(action === 1 ? 'start' : 'pause');
    if (action === 3) void controller.upgrade();
    if (Date.now() - lastRefresh >= 5000) { lastRefresh = Date.now(); void controller.refresh(); }
    await sleep(50);
  }
  controller.abort.abort();
  pending?.reject(new AuthorizationCancelled());
}

if (isMainThread) {
  const check = process.argv.includes('--worker-check');
  const uiCheck = process.argv.includes('--ui-check');
  const worker = new Worker(new URL(import.meta.url), { workerData: { demo: process.argv.includes('--demo') || uiCheck, check } });
  if (check) {
    worker.on('message', (value: string) => console.log(value));
    worker.on('error', (error: Error) => { console.error(error.message); process.exitCode = 1; });
  } else {
    worker.on('error', (error: Error) => nativeAlert(error.message, true));
    process.exitCode = nativeRun(uiCheck);
    await worker.terminate();
  }
} else {
  const data = workerData as { demo: boolean; check: boolean };
  if (data.check) {
    if (nativeMainThread()) throw new Error('App engine is not running on a worker thread.');
    await engine(false, true);
    parentPort!.postMessage('PASS: ScriptC worker thread calls the native C bridge.');
  } else {
    try { await engine(data.demo); }
    catch (error) { nativeAlert(errorMessage(error), true); }
  }
}
