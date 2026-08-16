/**
 * Entry point: boot the API and handle graceful shutdown. Always boots on
 * import — tests import app.ts instead.
 */
import { loadConfig } from './config';
import { buildApp } from './app';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app } = await buildApp({ config });
  const address = await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info({ address }, 'gather-api listening');

  let shuttingDown = false;
  const onSignal = (): void => {
    // A second signal means the graceful close is stuck — force it.
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

main().catch((err: unknown) => {
  console.error('failed to boot gather-api', err);
  process.exit(1);
});
