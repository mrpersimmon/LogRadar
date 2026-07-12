use criterion::{criterion_group, criterion_main, Criterion};
use logradar_core::LineIndexer;

fn bench_indexing(c: &mut Criterion) {
    let txt: String = (0..200_000).map(|i| format!("line-{i:06}\n")).collect();
    let bytes = txt.into_bytes();
    c.bench_function("build_index_200k", |b| {
        b.iter(|| LineIndexer::build(&bytes, 256));
    });
    let idx = LineIndexer::build(&bytes, 256);
    c.bench_function("random_access_200k", |b| {
        b.iter(|| idx.line_at(&bytes, 100_000));
    });
}

criterion_group!(benches, bench_indexing);
criterion_main!(benches);
