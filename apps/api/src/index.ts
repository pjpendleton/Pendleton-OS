import {
  CommandIntakeService,
  InMemoryIdempotencyRegistry,
  standardCommandCatalog,
} from '@pendleton-os/application';
import { CONTRACT_VERSION } from '@pendleton-os/contracts';

export const kernelStatus = Object.freeze({
  service: 'pendleton-os-api',
  contractVersion: CONTRACT_VERSION,
  status: 'foundation',
});

export const commandIntake = new CommandIntakeService({
  catalog: standardCommandCatalog,
  idempotencyRegistry: new InMemoryIdempotencyRegistry(),
});
