"""Write datasets in the format read by src/data.js.

Each dataset is one little-endian binary file. Fields are stored one after the
other (structure of arrays), each 4-byte aligned. index.json records, for every
field, its byte offset, element type and number of components per item.
"""
import json
import numpy as np

DT = {"f32": np.float32, "u8": np.uint8, "u16": np.uint16, "i32": np.int32, "u32": np.uint32}


def write_dataset(path, fields, units=None):
    """fields: dict name -> (type, size, array). Returns the index entry."""
    count = None
    spec = {}
    blobs = []
    off = 0
    for name, (typ, size, arr) in fields.items():
        a = np.ascontiguousarray(np.asarray(arr, dtype=DT[typ]).reshape(-1))
        n = a.size // size
        if count is None:
            count = n
        assert n == count, f"{name}: {n} items, expected {count}"
        spec[name] = {"offset": off, "type": typ, "size": size}
        b = a.tobytes()
        pad = (-len(b)) % 4
        blobs.append(b + b"\0" * pad)
        off += len(b) + pad
    with open(path, "wb") as f:
        for b in blobs:
            f.write(b)
    entry = {"url": path.split("/")[-1], "count": int(count or 0), "fields": spec}
    if units:
        entry["units"] = units
    return entry


def num(value, unit="", label="", derivation="", digits=3):
    return {"value": float(value), "unit": unit, "label": label, "derivation": derivation, "digits": digits}


def write_index(path, index):
    with open(path, "w") as f:
        json.dump(index, f, indent=1, ensure_ascii=False)
