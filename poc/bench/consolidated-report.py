#!/usr/bin/env python3
"""Build both standalone readers; refresh saved evidence only when requested."""

import argparse
from pathlib import Path
import subprocess
import sys

from report_reader import build_reports

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--refresh-evidence', action='store_true', help='Audit retained local results and regenerate aggregate data/SVGs. Requires matplotlib.')
args = parser.parse_args()
if args.refresh_evidence:
    subprocess.run([sys.executable, str(Path(__file__).with_name('collect-report-evidence.py'))], check=True)
build_reports()
print('Built Chinese and English standalone HTML readers from saved data; no model calls.')
