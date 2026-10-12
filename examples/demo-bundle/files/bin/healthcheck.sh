#!/bin/sh
# Exits 0 when the demo service answers on its TLS port.
exec nc -z 127.0.0.1 8443
