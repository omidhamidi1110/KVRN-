# External recovery checklist

1. Identify the production incident and stop writes through established infrastructure controls.
2. Verify the intended Neon source, target and recovery point out of band.
3. Create an independent encrypted copy and checksum using the provider-approved workflow.
4. Practice recovery into a separate isolated database and check table counts, payments, inventory and order audit chains.
5. Record the actual backup/restore outcome in Admin Backups only after the external operation finished.
6. Obtain explicit owner approval before any production restore or cutover.
