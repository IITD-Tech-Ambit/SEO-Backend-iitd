import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildComprehensiveGoldenSet, extractKeywords, getAuthorSurname, pickDeterministic } from '../scripts/build_comprehensive_golden_set.mjs';

const sampleCorpus = {
    total_documents: 12,
    documents: [
        { mongo_id: 'e1', title: 'Machine learning for solar panel efficiency prediction', abstract: 'We propose neural networks for photovoltaic output forecasting using weather data and historical generation patterns in detail.', field_associated: 'Engineering', kerberos: 'alice', authors: [{ name: 'Smith, John' }] },
        { mongo_id: 'e2', title: 'Machine learning models for power grid stability', abstract: 'Predictive models improve grid reliability using historical load and renewable generation datasets across regions.', field_associated: 'Engineering', kerberos: 'alice2', authors: [{ name: 'Smith, Jane' }] },
        { mongo_id: 'e3', title: 'Machine learning optimization in engineering systems', abstract: 'Optimization frameworks combine learning with control for complex engineering process automation and monitoring.', field_associated: 'Engineering', authors: [{ name: 'Brown, Alex' }] },
        { mongo_id: 'c1', title: 'Deep learning neural network architecture for image segmentation', abstract: 'Convolutional models improve semantic segmentation accuracy on medical imaging datasets with novel attention layers.', field_associated: 'Computer Science', kerberos: 'bob', authors: [{ name: 'Kumar, Rajesh' }] },
        { mongo_id: 'c2', title: 'Deep learning neural network training for vision tasks', abstract: 'Training strategies for deep networks on large-scale vision benchmarks with improved generalization properties.', field_associated: 'Computer Science', authors: [{ name: 'Lee, Min' }] },
        { mongo_id: 'c3', title: 'Deep learning neural network compression methods', abstract: 'Pruning and quantization reduce model size while preserving accuracy on edge deployment hardware platforms.', field_associated: 'Computer Science', authors: [{ name: 'Park, Sun' }] },
        { mongo_id: 'm1', title: 'Finite element simulation of alloy mechanical properties', abstract: 'Numerical modeling of stress distribution in metallic alloys under thermal loading conditions and cyclic fatigue.', field_associated: 'Materials Science', authors: [{ name: 'Patel, Anil' }] },
        { mongo_id: 'm2', title: 'Finite element simulation of composite material strength', abstract: 'Simulation pipelines evaluate composite laminates under impact loading with validated experimental correlations.', field_associated: 'Materials Science', kerberos: 'carol', authors: [{ name: 'Chen, Wei' }] },
        { mongo_id: 'm3', title: 'Finite element simulation of nanostructured alloys', abstract: 'Multiscale models link atomistic behavior to macroscopic mechanical response in nanostructured metallic materials.', field_associated: 'Materials Science', authors: [{ name: 'Singh, Dev' }] },
        { mongo_id: 's1', title: 'Solar energy integration in power grid systems', abstract: 'Renewable integration challenges for distribution networks with high photovoltaic penetration and storage coupling.', field_associated: 'Energy', authors: [{ name: 'Roy, K' }] },
        { mongo_id: 's2', title: 'Solar energy forecasting for photovoltaic plants', abstract: 'Short-term forecasting improves dispatch using satellite imagery and on-site sensor fusion techniques.', field_associated: 'Energy', authors: [{ name: 'Das, P' }] },
        { mongo_id: 's3', title: 'Solar energy economics in developing markets', abstract: 'Cost-benefit analysis of distributed solar adoption in rural electrification programs across multiple countries.', field_associated: 'Energy', authors: [{ name: 'Nair, S' }] },
    ],
};

describe('buildComprehensiveGoldenSet', () => {
    it('produces queries for all major categories', () => {
        const gs = buildComprehensiveGoldenSet(sampleCorpus, {
            perCategory: { exact_title: 3, partial_title: 3, abstract_keyword: 2, semantic: 2, author: 2, cross_field: 2 },
        });
        const types = new Set(gs.queries.map(q => q.type));
        assert.ok(types.has('exact_title'));
        assert.ok(types.has('partial_title'));
        assert.ok(types.has('field_broad'));
        assert.ok(types.has('multi_relevant'));
        assert.ok(gs.queries.every(q => Object.keys(q.relevant).length > 0));
    });

    it('mines multi_relevant clusters from corpus bigrams', () => {
        const gs = buildComprehensiveGoldenSet(sampleCorpus);
        const topics = gs.queries.filter(q => q.type === 'multi_relevant');
        assert.ok(topics.length >= 1);
        assert.ok(topics.some(q => q.query.includes('machine learning') || q.query.includes('solar energy')));
    });

    it('author queries prefer kerberos papers', () => {
        const gs = buildComprehensiveGoldenSet(sampleCorpus, { perCategory: { author: 2 } });
        const authors = gs.queries.filter(q => q.type === 'author');
        assert.ok(authors.some(q => q.kerberos));
    });
});

describe('helpers', () => {
    it('extractKeywords strips stopwords', () => {
        const kw = extractKeywords('A study of the optimization algorithm for water treatment', 4);
        assert.ok(!kw.includes('study'));
        assert.ok(kw.includes('optimization'));
    });

    it('getAuthorSurname returns last name token', () => {
        assert.equal(getAuthorSurname({ authors: [{ name: 'Smith, John' }] }), 'John');
        assert.equal(getAuthorSurname({ authors: [{ name: 'Kumar, Rajesh' }] }), 'Rajesh');
    });

    it('pickDeterministic is stable', () => {
        const a = pickDeterministic(sampleCorpus.documents, 3, 2);
        const b = pickDeterministic(sampleCorpus.documents, 3, 2);
        assert.deepEqual(a.map(d => d.mongo_id), b.map(d => d.mongo_id));
    });
});
