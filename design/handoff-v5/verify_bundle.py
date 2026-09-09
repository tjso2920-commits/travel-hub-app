from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parent
manifest=json.loads((root/'SHA256SUMS.json').read_text())
for name,expected in manifest.items():
    file=root/name
    assert file.is_file(), 'Missing: '+name
    assert hashlib.sha256(file.read_bytes()).hexdigest()==expected, 'Changed: '+name
print('Approved bundle verified:',len(manifest),'files')
