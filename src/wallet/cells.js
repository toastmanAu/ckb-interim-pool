'use strict';
/**
 * Enumerate treasury cells, attach the epoch information needed for cellbase
 * maturity, and select inputs oldest-first.
 */

const { spendableSplit } = require('./treasury.js');

/** CKB packs epoch number(0-23) | index(24-39) | length(40-55). */
function parseEpochFields(epochHex) {
  if (typeof epochHex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(epochHex)) {
    throw new Error('epoch must be a 0x-prefixed hexadecimal EpochNumberWithFraction');
  }
  const value = BigInt(epochHex);
  if ((value >> 56n) !== 0n) throw new Error('epoch contains non-zero reserved bits');
  const epoch = {
    number: Number(value & 0xffffffn),
    index: Number((value >> 24n) & 0xffffn),
    length: Number((value >> 40n) & 0xffffn),
  };
  if (epoch.length <= 0) throw new Error('epoch length must be positive');
  if (epoch.index >= epoch.length) {
    throw new Error(`epoch index ${epoch.index} must be less than length ${epoch.length}`);
  }
  return epoch;
}

function parseHexInteger(value, field) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${field} must be a 0x-prefixed hexadecimal integer`);
  }
  return BigInt(value);
}

/** Shape ckb-indexer cells for maturity calculation and input selection. */
function classifyCells(rawCells) {
  if (!Array.isArray(rawCells)) throw new Error('rawCells must be an array');
  return rawCells.map(cell => {
    if (!cell?.output || !cell.out_point) throw new Error('indexer cell is missing output or out_point');
    const block = parseHexInteger(cell.block_number, 'block_number');
    if (block > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('block_number exceeds safe integer range');
    const capacity = parseHexInteger(cell.output.capacity, 'capacity');
    const txIndex = parseHexInteger(cell.tx_index, 'tx_index');
    return {
      capacity: capacity.toString(),
      blockNumber: Number(block),
      blockEpoch: parseEpochFields(cell.block_epoch),
      isCellbase: txIndex === 0n,
      outPoint: cell.out_point,
    };
  });
}

/** Take cells oldest-first until targetShannons is covered. */
function selectOldestFirst(cells, targetShannons) {
  const target = BigInt(targetShannons);
  if (target < 0n) throw new Error('targetShannons must not be negative');
  const ordered = [...cells].sort((left, right) => left.blockNumber - right.blockNumber);
  const selected = [];
  let total = 0n;
  for (const cell of ordered) {
    if (total >= target) break;
    selected.push(cell);
    total += BigInt(cell.capacity);
  }
  return { selected, total: total.toString() };
}

/**
 * Collect every live cell at a lock using ckb-indexer's cursor.
 *
 * `get_cells` does not include the creating block's epoch, so each unique
 * block header is fetched from the node and its packed epoch is attached to
 * the returned raw cell. Without that metadata cellbase maturity cannot be
 * decided safely.
 */
async function collectLiveCells({ indexerUrl, nodeUrl = indexerUrl, lock, rpc }) {
  if (!indexerUrl) throw new Error('indexerUrl is required');
  if (!nodeUrl) throw new Error('nodeUrl is required');
  if (!lock) throw new Error('treasury lock is required');
  if (typeof rpc !== 'function') throw new Error('rpc function is required');

  const cells = [];
  let after = null;
  for (let page = 0; page < 200; page++) {
    const query = {
      script: { code_hash: lock.code_hash, hash_type: lock.hash_type, args: lock.args },
      script_type: 'lock',
      filter: null,
      with_data: false,
      order: 'asc',
      limit: '0x64',
    };
    if (after) query.after = after;
    const response = await rpc(indexerUrl, 'get_cells', [query]);
    const objects = response?.objects;
    if (!Array.isArray(objects)) throw new Error('indexer get_cells returned no objects array');
    cells.push(...objects);
    if (objects.length === 0 || !response.last_cursor || response.last_cursor === '0x') break;
    if (response.last_cursor === after) throw new Error('indexer get_cells cursor did not advance');
    after = response.last_cursor;
    if (page === 199) throw new Error('indexer get_cells exceeded 200 pages');
  }

  const epochsByBlock = new Map();
  await Promise.all(cells.map(async cell => {
    if (cell.block_epoch) return;
    const height = cell.block_number;
    if (!epochsByBlock.has(height)) {
      epochsByBlock.set(height, (async () => {
        const header = await rpc(nodeUrl, 'get_header_by_number', [height]);
        if (!header?.epoch) throw new Error(`node returned no header epoch for block ${height}`);
        // Validate before returning so bad node data never reaches selection.
        parseEpochFields(header.epoch);
        return header.epoch;
      })());
    }
    cell.block_epoch = await epochsByBlock.get(height);
  }));
  return cells;
}

/** Classified cells plus total/spendable values at the supplied tip epoch. */
function treasuryView({ rawCells, tipEpochHex }) {
  const cells = classifyCells(rawCells);
  const split = spendableSplit({ cells, tipEpoch: parseEpochFields(tipEpochHex) });
  return { cells, ...split };
}

module.exports = {
  parseEpochFields,
  classifyCells,
  selectOldestFirst,
  collectLiveCells,
  treasuryView,
};
