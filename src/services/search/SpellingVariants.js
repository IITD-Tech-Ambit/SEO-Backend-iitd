/**
 * British/American English spelling variants.
 *
 * Pure, dependency-free lookups used by the query builders so a query typed in one
 * spelling still matches documents written in the other (e.g. "behaviour" <-> "behavior").
 */

// [american, british] pairs. Prefix matching extends these to derived forms
// (e.g. color -> colour also maps colorful -> colourful).
const VARIANT_PAIRS = [
    ['color', 'colour'], ['favor', 'favour'], ['honor', 'honour'],
    ['humor', 'humour'], ['labor', 'labour'], ['neighbor', 'neighbour'],
    ['vapor', 'vapour'], ['fiber', 'fibre'], ['center', 'centre'],
    ['liter', 'litre'], ['meter', 'metre'], ['caliber', 'calibre'],
    ['theater', 'theatre'], ['defense', 'defence'], ['offense', 'offence'],
    ['license', 'licence'], ['practice', 'practise'],
    ['analyze', 'analyse'], ['catalyze', 'catalyse'],
    ['optimize', 'optimise'], ['recognize', 'recognise'],
    ['characterize', 'characterise'], ['minimize', 'minimise'],
    ['maximize', 'maximise'], ['utilize', 'utilise'],
    ['realize', 'realise'], ['organize', 'organise'],
    ['stabilize', 'stabilise'], ['polymerize', 'polymerise'],
    ['synthesize', 'synthesise'], ['oxidize', 'oxidise'],
    ['ionize', 'ionise'], ['polarize', 'polarise'],
    ['crystallize', 'crystallise'], ['paralyze', 'paralyse'],
    ['modeling', 'modelling'], ['traveling', 'travelling'],
    ['labeling', 'labelling'], ['canceling', 'cancelling'],
    ['aluminum', 'aluminium'], ['sulfur', 'sulphur'],
    ['aging', 'ageing'], ['gray', 'grey'],
];

/**
 * Return the spelling variant of a word, or null if none is known.
 */
export function getSpellingVariant(word) {
    const w = (word || '').toLowerCase();
    for (const [am, br] of VARIANT_PAIRS) {
        if (w === am) return br;
        if (w === br) return am;
        if (w.startsWith(am)) return br + w.slice(am.length);
        if (w.startsWith(br)) return am + w.slice(br.length);
    }
    return null;
}
