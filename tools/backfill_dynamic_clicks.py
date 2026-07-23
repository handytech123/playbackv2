import argparse
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = APP_ROOT / "data"
LIBRARY_FILE = DATA_DIR / "library.json"
SONG_METADATA_DIR = DATA_DIR / "song-metadata"
REPORT_DIR = DATA_DIR / "reports"
STAMP = datetime.utcnow().isoformat(timespec="seconds").replace(":", "-")
BACKUP_DIR = DATA_DIR / "metadata-backups" / f"dynamic-click-backfill-{STAMP}"


def load_analyzer(analyzer_root):
    analyzer_root = Path(analyzer_root)
    if str(analyzer_root) not in sys.path:
        sys.path.insert(0, str(analyzer_root))
    from analyzer.audio_loader import load_audio
    from analyzer.click_transients import detect_click_transients
    from analyzer.dynamic_click import dynamic_click_pattern, missing_click_pattern

    return load_audio, detect_click_transients, dynamic_click_pattern, missing_click_pattern


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, value, dry_run=False):
    path = Path(path)
    if dry_run:
        return False
    backup(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    return True


def backup(path):
    path = Path(path)
    if not path.exists():
        return
    target = BACKUP_DIR / path.relative_to(DATA_DIR) if is_under(path, DATA_DIR) else BACKUP_DIR / "source-folders" / path.name
    if not is_under(path, DATA_DIR):
        try:
            parts = list(path.parts)
            if "Backing Tracks" in parts:
                target = BACKUP_DIR / "source-folders" / Path(*parts[parts.index("Backing Tracks") + 1 :])
        except Exception:
            pass
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, target)


def is_under(path, parent):
    try:
        Path(path).resolve().relative_to(Path(parent).resolve())
        return True
    except ValueError:
        return False


def display_time_signature(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        if value.get("display"):
            return str(value["display"])
        numerator = value.get("numerator")
        denominator = value.get("denominator")
        if numerator and denominator:
            return f"{numerator}/{denominator}"
    return ""


def click_path_for_song(song_folder, grid):
    click = grid.get("clickStem") if isinstance(grid.get("clickStem"), dict) else {}
    candidates = [
        click.get("absolutePath"),
        grid.get("sourceClickWavPath"),
        grid.get("selectedClickStem"),
        click.get("path"),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        if not path.is_absolute():
            path = Path(song_folder) / candidate
        if path.exists():
            return path
    return None


def dynamic_click_for_song(song, grid, analyzer_functions):
    load_audio, detect_click_transients, dynamic_click_pattern, missing_click_pattern = analyzer_functions
    song_folder = Path(song["folderPath"])
    click_path = click_path_for_song(song_folder, grid)
    if not click_path:
        return missing_click_pattern()
    audio = load_audio(click_path)
    transient_evidence = detect_click_transients(audio)
    return dynamic_click_pattern(song_folder, click_path, transient_evidence, display_time_signature(grid.get("timeSignature")))


def update_metadata_file(path, dynamic_click, dry_run=False):
    if not path.exists():
        return False
    metadata = read_json(path)
    metadata["dynamicClick"] = dynamic_click
    write_json(path, metadata, dry_run=dry_run)
    return True


def update_grid_file(path, dynamic_click, dry_run=False):
    if not path.exists():
        return False
    grid = read_json(path)
    grid["dynamicClick"] = dynamic_click
    write_json(path, grid, dry_run=dry_run)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--analyzer-root", default="D:/Analyze V2")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    analyzer_functions = load_analyzer(args.analyzer_root)
    library = read_json(LIBRARY_FILE)
    songs = library.get("songs") or []
    if args.limit:
        songs = songs[: args.limit]

    results = []
    failures = []
    for index, song in enumerate(songs, start=1):
        title = song.get("title") or song.get("folderPath")
        try:
            song_folder = Path(song["folderPath"])
            source_grid_path = song_folder / "analysis" / "grid-analysis.json"
            source_metadata_path = song_folder / "song-metadata.json"
            app_metadata_dir = SONG_METADATA_DIR / song["id"]
            app_grid_path = app_metadata_dir / "analysis" / "grid-analysis.json"
            app_metadata_path = app_metadata_dir / "song-metadata.json"
            grid = read_json(source_grid_path)
            dynamic_click = dynamic_click_for_song(song, grid, analyzer_functions)

            source_metadata_updated = update_metadata_file(source_metadata_path, dynamic_click, dry_run=args.dry_run)
            source_grid_updated = update_grid_file(source_grid_path, dynamic_click, dry_run=args.dry_run)
            app_metadata_updated = update_metadata_file(app_metadata_path, dynamic_click, dry_run=args.dry_run)
            app_grid_updated = update_grid_file(app_grid_path, dynamic_click, dry_run=args.dry_run)

            row = {
                "songId": song["id"],
                "title": title,
                "status": dynamic_click.get("status"),
                "patternLength": dynamic_click.get("patternLength"),
                "pattern": dynamic_click.get("pattern"),
                "countPattern": dynamic_click.get("countPattern"),
                "clickEventCount": dynamic_click.get("clickEventCount"),
                "confidence": dynamic_click.get("confidence"),
                "clickStemPath": dynamic_click.get("clickStemPath"),
                "sourceMetadataUpdated": source_metadata_updated,
                "sourceGridUpdated": source_grid_updated,
                "appMetadataUpdated": app_metadata_updated,
                "appGridUpdated": app_grid_updated,
                "warnings": dynamic_click.get("warnings") or [],
            }
            results.append(row)
            print(f"[dynamic-click] {index}/{len(songs)} {title}: {row['status']} {row['countPattern']}", flush=True)
        except Exception as error:
            failures.append({
                "songId": song.get("id"),
                "title": title,
                "folderPath": song.get("folderPath"),
                "error": str(error),
            })
            print(f"[dynamic-click:failed] {index}/{len(songs)} {title}: {error}", flush=True)

    summary = {
        "generatedAt": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "dryRun": args.dry_run,
        "total": len(songs),
        "updated": len(results),
        "failures": len(failures),
        "ready": sum(1 for row in results if row["status"] == "ready"),
        "review": sum(1 for row in results if row["status"] == "review"),
        "missingClickStem": sum(1 for row in results if row["status"] == "missing-click-stem"),
        "backupDir": None if args.dry_run else str(BACKUP_DIR),
        "results": results,
        "failureDetails": failures,
    }
    if not args.dry_run:
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        (REPORT_DIR / f"dynamic-click-backfill-{STAMP}.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2), flush=True)
    return 2 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
