#!/usr/bin/env python3
"""Report bounded structural evidence from a DOCX, XLSX, or PPTX archive."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile


def xml_root(archive: ZipFile, name: str) -> ElementTree.Element:
    return ElementTree.fromstring(archive.read(name))


def inspect_office_file(path: Path, file_format: str) -> dict[str, int]:
    with ZipFile(path) as archive:
        if archive.testzip() is not None:
            raise ValueError("Office archive CRC validation failed")
        names = set(archive.namelist())
        if file_format == "docx":
            root = xml_root(archive, "word/document.xml")
            namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            return {
                "tableCount": len(root.findall(".//w:tbl", namespace)),
                "imageCount": len([name for name in names if name.startswith("word/media/") and not name.endswith("/")]),
            }
        if file_format == "xlsx":
            worksheets = sorted(name for name in names if name.startswith("xl/worksheets/sheet") and name.endswith(".xml"))
            formula_count = 0
            namespace = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
            for worksheet in worksheets:
                formula_count += len(xml_root(archive, worksheet).findall(".//s:f", namespace))
            return {
                "worksheetCount": len(worksheets),
                "formulaCount": formula_count,
                "chartCount": len([name for name in names if name.startswith("xl/charts/chart") and name.endswith(".xml")]),
            }
        if file_format == "pptx":
            return {
                "slideCount": len([name for name in names if name.startswith("ppt/slides/slide") and name.endswith(".xml")]),
                "layoutCount": len([name for name in names if name.startswith("ppt/slideLayouts/slideLayout") and name.endswith(".xml")]),
                "notesSlideCount": len([name for name in names if name.startswith("ppt/notesSlides/notesSlide") and name.endswith(".xml")]),
                "imageCount": len([name for name in names if name.startswith("ppt/media/") and not name.endswith("/")]),
            }
    raise ValueError(f"unsupported Office format: {file_format}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--format", required=True, choices=["docx", "xlsx", "pptx"])
    args = parser.parse_args()
    try:
        result = inspect_office_file(args.file, args.format)
    except (BadZipFile, KeyError, OSError, ValueError, ElementTree.ParseError) as error:
        raise SystemExit(f"OFFICE_STRUCTURE_INVALID: {error}") from error
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
