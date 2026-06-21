import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHardGoldenSet, buildTopicCluster, abstractOnlyTerms } from '../scripts/build_hard_golden_set.mjs';

const corpus = {
    total_documents: 10,
    documents: [
        { mongo_id: '1', title: 'Harmonic mitigation in AC-DC converters for vector controlled induction motor drives', abstract: 'This paper presents modulation strategies for induction motor drives with reduced current distortion and improved power quality under vector control schemes.', field_associated: 'Engineering', kerberos: 'a', authors: [{ name: 'Roy, A' }], citation_count: 10 },
        { mongo_id: '2', title: 'Nine-phase AC-DC converter for vector controlled induction motor drives', abstract: 'Multi-phase converter topology for induction motor applications with vector control and harmonic reduction techniques.', field_associated: 'Engineering', kerberos: 'b', authors: [{ name: 'Das, B' }], citation_count: 5 },
        { mongo_id: '3', title: 'Optimal PWM for minimization of current harmonic distortion in three-level inverters feeding induction motors', abstract: 'PWM optimization for three-level inverters supplying induction motor loads with minimized harmonic distortion.', field_associated: 'Engineering', authors: [{ name: 'Lee, C' }], citation_count: 8 },
        { mongo_id: '4', title: 'Optical properties of square-lattice microstructured optical fibers with thin films coating', abstract: 'Microstructured fibers with thin films exhibit unique optical properties for sensing applications in photonic devices.', field_associated: 'Physics and Astronomy', kerberos: 'c', authors: [{ name: 'Patel, D' }], citation_count: 3 },
        { mongo_id: '5', title: 'Synthesis of carbon nanotubes on silicon substrates using chemical vapor deposition thin films process', abstract: 'Carbon nanotube growth on silicon using CVD thin films with catalytic nanoparticle nucleation sites.', field_associated: 'Materials Science', authors: [{ name: 'Singh, E' }], citation_count: 6 },
        { mongo_id: '6', title: 'Impact resistance of shear thickening fluid treated p-aramid fabric soft armor materials', abstract: 'Shear thickening fluid impregnation improves impact resistance of p-aramid fabrics for soft body armor applications.', field_associated: 'Materials Science', kerberos: 'd', authors: [{ name: 'Majumdar, A' }], citation_count: 20 },
        { mongo_id: '7', title: 'Solar photovoltaic integration in microgrid power quality improvement algorithms', abstract: 'Photovoltaic integration algorithms improve microgrid power quality under variable solar generation conditions.', field_associated: 'Energy', authors: [{ name: 'Kumar, F' }], citation_count: 4 },
        { mongo_id: '8', title: 'Solar energy forecasting using satellite data for photovoltaic plant dispatch', abstract: 'Satellite-derived irradiance data enables short-term solar energy forecasting for photovoltaic plant operations.', field_associated: 'Energy', authors: [{ name: 'Shah, G' }], citation_count: 2 },
        { mongo_id: '9', title: 'An optimization mode for industrial load management in power systems', abstract: 'Industrial load scheduling optimization reduces peak demand in electrical power distribution networks.', field_associated: 'Engineering', authors: [{ name: 'Nair, H' }], citation_count: 1 },
        { mongo_id: '10', title: 'Differential influence of additives on insulin aggregation kinetics monitored by turbidity', abstract: 'Aggregation kinetics of insulin monitored by turbidity reveal differential additive effects on nucleation and growth phases.', field_associated: 'Chemistry', kerberos: 'e', authors: [{ name: 'Deep, S' }], citation_count: 12 },
    ],
};

describe('buildHardGoldenSet', () => {
    it('creates multiple hard categories with graded judgments', () => {
        const gs = buildHardGoldenSet(corpus);
        const types = new Set(gs.queries.map(q => q.type));
        assert.ok(types.has('hard_graded_cluster') || types.has('hard_ambiguous_recall'));
        assert.ok(gs.queries.some(q => Object.keys(q.relevant).length > 1));
    });

    it('buildTopicCluster assigns 3/2/1 grades', () => {
        const cluster = buildTopicCluster(corpus.documents, ['induction', 'motor'], { minDocs: 2 });
        assert.ok(cluster);
        assert.ok(cluster.relevant[cluster.anchor.mongo_id] === 3);
        assert.ok(Object.keys(cluster.relevant).length >= 2);
    });

    it('abstractOnlyTerms extracts vocabulary from abstract', () => {
        const terms = abstractOnlyTerms(corpus.documents[9]);
        assert.ok(terms.length >= 1);
    });
});
