#!/usr/bin/env python3

import json
import sys
from pathlib import Path

from jsonschema.validators import validator_for


def validate(schema_path: Path, document_path: Path) -> None:
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    document = json.loads(document_path.read_text(encoding="utf-8"))
    validator_class = validator_for(schema)
    validator_class.check_schema(schema)
    validator_class(schema).validate(document)
    print(f"valid: {document_path}")


if len(sys.argv) != 5:
    raise SystemExit(
        "usage: validate-cursor-schema.py "
        "<plugin-schema> <plugin-json> <marketplace-schema> <marketplace-json>"
    )

validate(Path(sys.argv[1]), Path(sys.argv[2]))
validate(Path(sys.argv[3]), Path(sys.argv[4]))
