# Install per-machine under Program Files

The GUI and helper ship as a per-machine NSIS installer under `%ProgramFiles%\WindhawkProfileManager`. A portable build would extract into a user-writable temp directory; elevating the helper from there lets a standard user replace the binary an administrator later runs. Per-machine installation keeps the privileged binary writable only by administrators.

Cost: admin rights once at install and no portable mode. The GUI still launches without elevation, and the helper is elevated only per apply through `runas`.
